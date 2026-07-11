import { describe, expect, it, vi } from "vitest";

const mockRunDream = vi.fn();
vi.mock("../src/dream-engine.js", () => ({
  runDream: (...args: unknown[]) => mockRunDream(...args),
}));
vi.mock("../src/run-status.js", () => ({ writePersistedDreamStatus: vi.fn() }));
vi.mock("../src/report/reporter.js", () => ({ formatReportMarkdown: vi.fn(() => "report") }));

import { createDreamNowTool } from "../src/tools/dream-trigger.js";

describe("dream_now rollout gate", () => {
  it("forces analysis-only mode even when dryRun=false is requested", async () => {
    mockRunDream.mockResolvedValue({
      report: {
        timestamp: new Date().toISOString(),
        scanned: 0,
        duplicates: { count: 0, pairs: [] },
        conflicts: { count: 0, pairs: [] },
        stale: { count: 0, entries: [] },
        timeIssues: { count: 0, entries: [] },
        supersession: { count: 0, proposals: [] },
        dryRun: true,
      },
    });
    const tool = createDreamNowTool({})({} as any);

    await tool.execute("test", { dryRun: false });

    expect(mockRunDream).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });
});
