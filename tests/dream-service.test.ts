import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDreamService, createDreamServiceWithInternals, _testing } from "../src/dream-service.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";

const mockRunDream = vi.fn();
const mockWritePersistedDreamStatus = vi.fn();

vi.mock("../src/dream-engine.js", () => ({
  runDream: (...args: unknown[]) => mockRunDream(...args),
}));

vi.mock("../src/run-status.js", () => ({
  writePersistedDreamStatus: (...args: unknown[]) => mockWritePersistedDreamStatus(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────

type AgentEndHandler = () => Promise<void>;

function createMockApi(configOverrides: Record<string, unknown> = {}): {
  api: OpenClawPluginApi;
  agentEndHandlers: AgentEndHandler[];
} {
  const agentEndHandlers: AgentEndHandler[] = [];

  const api = {
    pluginConfig: { ..._testing.DEFAULT_CONFIG, ...configOverrides },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((event: string, handler: AgentEndHandler) => {
      if (event === "agent_end") {
        agentEndHandlers.push(handler);
      }
    }),
    registerTool: vi.fn(),
    registerService: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return { api, agentEndHandlers };
}

function createMockCtx(): OpenClawPluginServiceContext {
  return {
    config: {} as OpenClawPluginServiceContext["config"],
    stateDir: "/tmp/autodream-test",
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createDreamService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunDream.mockReset();
    mockWritePersistedDreamStatus.mockReset();
    mockRunDream.mockResolvedValue({
      report: {
        timestamp: "2026-04-05T03:00:00.000Z",
        scanned: 10,
        duplicates: { count: 0, pairs: [] },
        conflicts: { count: 0, pairs: [] },
        stale: { count: 0, entries: [] },
        timeIssues: { count: 0, entries: [] },
        dryRun: true,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should return a service with id, start, and stop", () => {
    const { api } = createMockApi();
    const service = createDreamService(api);

    expect(service.id).toBe("autodream-scheduler");
    expect(typeof service.start).toBe("function");
    expect(typeof service.stop).toBe("function");
  });

  it("should register an agent_end handler", () => {
    const { api } = createMockApi();
    createDreamService(api);

    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
  });

  describe("scheduleNextRun timing", () => {
    it("should schedule for today if scheduleHour is in the future", () => {
      vi.setSystemTime(new Date("2026-04-05T01:00:00.000Z"));

      const { api } = createMockApi({ scheduleHour: 3 });
      const service = createDreamService(api);

      const ctx = createMockCtx();
      service.start(ctx);
      expect(vi.getTimerCount()).toBe(1);

      service.stop?.(ctx);
    });

    it("should schedule for tomorrow if scheduleHour has already passed", () => {
      vi.setSystemTime(new Date("2026-04-05T04:00:00.000Z"));

      const { api } = createMockApi({ scheduleHour: 3 });
      const service = createDreamService(api);

      const ctx = createMockCtx();
      service.start(ctx);
      expect(vi.getTimerCount()).toBe(1);

      service.stop?.(ctx);
    });
  });

  describe("session threshold gate", () => {
    it("should skip dream run when sessions < minSessionsSinceLastRun", async () => {
      // Place current time 1 second before scheduleHour
      vi.setSystemTime(new Date("2026-04-05T02:59:59.000Z"));

      const { api } = createMockApi({
        scheduleHour: 3,
        minSessionsSinceLastRun: 3,
      });

      const service = createDreamService(api);
      const ctx = createMockCtx();
      service.start(ctx);

      // Run the pending timer to trigger executeDream
      await vi.runOnlyPendingTimersAsync();

      // executeDream should have logged "Skipping" because sessionCount=0 < 3
      const debugCalls = (api.logger.debug as ReturnType<typeof vi.fn>).mock
        .calls;
      const skipMessage = debugCalls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes("Skipping"),
      );
      expect(skipMessage).toBeDefined();

      service.stop?.(ctx);
    });

    it("should increment sessionCount via agent_end handler", async () => {
      const { api, agentEndHandlers } = createMockApi();
      createDreamService(api);

      expect(agentEndHandlers.length).toBe(1);

      // Simulate agent_end events — should not throw
      await agentEndHandlers[0]!();
      await agentEndHandlers[0]!();
      await agentEndHandlers[0]!();
    });
  });

  describe("stop", () => {
    it("should clear the timer when stop is called", () => {
      vi.setSystemTime(new Date("2026-04-05T01:00:00.000Z"));

      const { api } = createMockApi({ scheduleHour: 3 });
      const service = createDreamService(api);

      const ctx = createMockCtx();
      service.start(ctx);
      expect(vi.getTimerCount()).toBe(1);

      service.stop?.(ctx);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("should be safe to call stop without start", () => {
      const { api } = createMockApi();
      const service = createDreamService(api);
      const ctx = createMockCtx();

      expect(() => service.stop?.(ctx)).not.toThrow();
    });
  });

  describe("scheduled execution", () => {
    it("writes persisted status after a scheduled run", async () => {
      const { api, agentEndHandlers } = createMockApi({
        minSessionsSinceLastRun: 1,
      });
      const { internals } = createDreamServiceWithInternals(api);

      await agentEndHandlers[0]!();
      await internals.executeDream();

      expect(mockRunDream).toHaveBeenCalledTimes(1);
      expect(mockWritePersistedDreamStatus).toHaveBeenCalledTimes(1);
      expect(mockWritePersistedDreamStatus).toHaveBeenCalledWith(
        expect.any(Object),
        "scheduled",
      );
    });

    it("treats scheduled runs as dry-run when no write actions are enabled", async () => {
      const { api, agentEndHandlers } = createMockApi({
        minSessionsSinceLastRun: 1,
        deepEnabled: true,
        autoMergeDuplicates: false,
        autoFixTime: false,
        autoDeleteStale: false,
      });
      const { internals } = createDreamServiceWithInternals(api);

      await agentEndHandlers[0]!();
      await internals.executeDream();

      expect(mockRunDream).toHaveBeenCalledTimes(1);
      expect(mockRunDream).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
        }),
      );
    });
  });

  describe("internals", () => {
    it("computes the next run using local time when today's schedule has passed", () => {
      const { api } = createMockApi({ scheduleHour: 3 });
      const { internals } = createDreamServiceWithInternals(api);

      const next = internals.computeNextRunTime(new Date("2026-04-05T04:00:00.000Z"));
      expect(next.toISOString()).toBe("2026-04-05T19:00:00.000Z");
    });
  });

  describe("default config", () => {
    it("should have sensible defaults", () => {
      const defaults = _testing.DEFAULT_CONFIG;

      expect(defaults.intervalHours).toBe(24);
      expect(defaults.scheduleHour).toBe(3);
      expect(defaults.minSessionsSinceLastRun).toBe(3);
      expect(defaults.autoMergeDuplicates).toBe(false);
      expect(defaults.autoFixTime).toBe(false);
      expect(defaults.autoDeleteStale).toBe(false);
      expect(defaults.staleAgeDays).toBe(60);
      expect(defaults.dedupThreshold).toBe(0.9);
      expect(defaults.maxChangesPerRun).toBe(20);
    });
  });
});
