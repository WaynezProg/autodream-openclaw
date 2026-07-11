import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDreamCli } from "../src/cli/dream-cli.js";
import { Command } from "commander";

// ── Mock dream-engine ────────────────────────────────────────────────

const mockRunDream = vi.fn();
vi.mock("../src/dream-engine.js", () => ({
  runDream: (...args: unknown[]) => mockRunDream(...args),
}));

// ── Mock reporter (pass-through) ─────────────────────────────────────

vi.mock("../src/report/reporter.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/report/reporter.js")>();
  return {
    ...original,
    formatReportMarkdown: vi.fn((report) => `MOCK_REPORT:${report.scanned}`),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────

function buildCtx() {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests

  return { ctx: { program }, program };
}

function fakeResult(scanned = 10) {
  return {
    report: {
      timestamp: "2026-04-05T03:00:00.000Z",
      scanned,
      duplicates: { count: 0, pairs: [] },
      timeIssues: { count: 0, entries: [] },
      conflicts: { count: 0, pairs: [] },
      stale: { count: 0, entries: [] },
      dryRun: true,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("dream CLI command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRunDream.mockReset();
  });

  it("registers the dream command", () => {
    const { ctx, program } = buildCtx();
    registerDreamCli(ctx, {});

    const cmd = program.commands.find((c) => c.name() === "dream");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("Run memory consolidation (autoDream)");
  });

  it("passes --dry-run true by default", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {});
    await program.parseAsync(["dream"], { from: "user" });

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("passes --no-dry-run correctly", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {});
    await program.parseAsync(["dream", "--no-dry-run"], { from: "user" });

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("does not apply supersession with --no-dry-run alone", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {});
    await program.parseAsync(["dream", "--no-dry-run"], { from: "user" });

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, supersessionApply: false }),
    );
  });

  it("passes supersession apply switches", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {});
    await program.parseAsync(
      ["dream", "--no-dry-run", "--apply-supersession", "--supersession-max", "10"],
      { from: "user" },
    );

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        supersessionApply: true,
        supersessionMaxChangesPerRun: 10,
      }),
    );
  });

  it("passes --scope option to runDream", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {});
    await program.parseAsync(["dream", "--scope", "personal"], {
      from: "user",
    });

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "personal" }),
    );
  });

  it("forwards plugin config values to runDream", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {
      dedupThreshold: 0.85,
      maxChangesPerRun: 10,
      staleAgeDays: 30,
    });
    await program.parseAsync(["dream"], { from: "user" });

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupThreshold: 0.85,
        maxChangesPerRun: 10,
        staleAgeDays: 30,
      }),
    );
  });

  it("prints markdown report to stdout", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult(42));

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerDreamCli(ctx, {});
    await program.parseAsync(["dream"], { from: "user" });

    expect(spy).toHaveBeenCalledWith("MOCK_REPORT:42");
    spy.mockRestore();
  });

  it("prints warning when result has error field", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue({
      ...fakeResult(),
      error: "Schema detection failed",
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerDreamCli(ctx, {});
    await program.parseAsync(["dream"], { from: "user" });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Schema detection failed"),
    );
    spy.mockRestore();
  });

  it("exits with code 1 on thrown error", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockRejectedValue(new Error("DB connection failed"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    registerDreamCli(ctx, {});
    await program.parseAsync(["dream"], { from: "user" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("DB connection failed"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("ignores non-number/non-boolean plugin config values", async () => {
    const { ctx, program } = buildCtx();
    mockRunDream.mockResolvedValue(fakeResult());

    registerDreamCli(ctx, {
      dedupThreshold: "not-a-number",
      autoMergeDuplicates: "true",
    });
    await program.parseAsync(["dream"], { from: "user" });

    expect(mockRunDream).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupThreshold: undefined,
        autoMergeDuplicates: undefined,
      }),
    );
  });
});
