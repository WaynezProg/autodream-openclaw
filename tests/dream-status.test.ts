import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadPersistedDreamStatus = vi.fn();
const mockGetLastRunResult = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTableNames = vi.fn();
const mockCountMemories = vi.fn();
const mockGetTableSchema = vi.fn();
const mockReadLog = vi.fn();
const mockGetStats = vi.fn();

vi.mock("../src/run-status.js", () => ({
  readPersistedDreamStatus: (...args: unknown[]) => mockReadPersistedDreamStatus(...args),
}));

vi.mock("../src/dream-engine.js", () => ({
  getLastRunResult: (...args: unknown[]) => mockGetLastRunResult(...args),
}));

vi.mock("../src/lancedb-adapter.js", () => ({
  LanceDbAdapter: class {
    connect = mockConnect;
    close = mockClose;
    listTableNames = mockListTableNames;
    countMemories = mockCountMemories;
    getTableSchema = mockGetTableSchema;
  },
}));

vi.mock("../src/tracking/recall-tracker.js", () => ({
  RecallTracker: class {
    readLog = mockReadLog;
    getStats = mockGetStats;
  },
}));

import { createDreamStatusTool } from "../src/tools/dream-status.js";

describe("dream_status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockReadPersistedDreamStatus.mockReset();
    mockGetLastRunResult.mockReset();
    mockConnect.mockReset();
    mockClose.mockReset();
    mockListTableNames.mockReset();
    mockCountMemories.mockReset();
    mockGetTableSchema.mockReset();
    mockReadLog.mockReset();
    mockGetStats.mockReset();

    mockReadPersistedDreamStatus.mockResolvedValue({
      updatedAt: "2026-04-10T01:00:00.000Z",
      lastRun: {
        timestamp: "2026-04-10T00:00:00.000Z",
        scanned: 321,
        duplicates: 7,
        conflicts: 1,
        dryRun: false,
        trigger: "scheduled",
        promotions: 2,
        reflection: true,
      },
      lastDeepPromotion: {
        date: "2026-04-10",
        count: 2,
        entries: ["m1", "m2"],
        source: "status",
      },
      lastRemReflection: {
        period: "2026-W15",
        themes: ["theme-a", "theme-b"],
        source: "status",
      },
    });
    mockGetLastRunResult.mockReturnValue(null);
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTableNames.mockResolvedValue(["memories"]);
    mockCountMemories.mockResolvedValue(3967);
    mockGetTableSchema.mockResolvedValue(["id", "text", "vector"]);
    mockReadLog.mockResolvedValue([{ ts: Date.parse("2026-04-01T00:00:00.000Z") }]);
    mockGetStats.mockResolvedValue([{ memoryId: "abc", totalRecalls: 12 }]);
  });

  it("uses persisted status when no in-session run exists", async () => {
    const tool = createDreamStatusTool()({} as never);
    const result = await tool.execute("call-1", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("**Trigger:** scheduled");
    expect(text).toContain("**Deep Promotions:** 2");
    expect(text).toContain("**REM Reflection:** Yes");
    expect(text).toContain("**Source:** status");
  });

  it("prefers in-session run for last run summary", async () => {
    mockGetLastRunResult.mockReturnValue({
      report: {
        timestamp: "2026-04-10T02:00:00.000Z",
        scanned: 50,
        duplicates: { count: 1, pairs: [] },
        conflicts: { count: 0, pairs: [] },
        stale: { count: 0, entries: [] },
        timeIssues: { count: 0, entries: [] },
        dryRun: true,
        promotions: { count: 0, entries: [] },
        reflection: undefined,
      },
      error: undefined,
    });

    const tool = createDreamStatusTool()({} as never);
    const result = await tool.execute("call-2", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("**Time:** 2026-04-10T02:00:00.000Z");
    expect(text).toContain("**Trigger:** manual");
    expect(text).toContain("**Dry-run:** Yes");
  });
});
