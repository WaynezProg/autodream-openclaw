import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupersessionProposal } from "../src/analysis/supersession-detector.js";

const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockGetTableSchema = vi.fn().mockResolvedValue([
  "id",
  "text",
  "vector",
  "category",
  "scope",
  "importance",
  "timestamp",
  "metadata",
]);
const mockListAllMemories = vi.fn();
const mockDeleteMemory = vi.fn().mockResolvedValue(true);
const mockUpdateMemoryText = vi.fn().mockResolvedValue(true);
const mockUpdateMemoryTextAndVector = vi.fn().mockResolvedValue(true);
const mockUpdateMemoryMetadata = vi.fn().mockResolvedValue(true);

vi.mock("../src/lancedb-adapter.js", () => ({
  LanceDbAdapter: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    getTableSchema: mockGetTableSchema,
    listAllMemories: mockListAllMemories,
    deleteMemory: mockDeleteMemory,
    updateMemoryText: mockUpdateMemoryText,
    updateMemoryTextAndVector: mockUpdateMemoryTextAndVector,
    updateMemoryMetadata: mockUpdateMemoryMetadata,
  })),
  parseMetadata: (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  },
}));

vi.mock("../src/analysis/dedup-detector.js", () => ({
  detectDuplicates: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/analysis/time-normalizer.js", () => ({
  detectRelativeTime: vi.fn().mockReturnValue([]),
  resolveTimeWithLlm: vi.fn(),
}));

vi.mock("../src/analysis/conflict-detector.js", () => ({
  detectConflictsWithAmbiguous: vi.fn().mockReturnValue({ confirmed: [], ambiguous: [] }),
  confirmConflictsWithLlm: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/analysis/staleness-scorer.js", () => ({
  scoreAndFilterStale: vi.fn().mockReturnValue([]),
  detectNoiseMemories: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/analysis/dedup-merger.js", () => ({
  mergeWithLlm: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/analysis/llm-helper.js", () => ({
  LlmHelper: vi.fn().mockImplementation(() => ({ used: 0 })),
  DEFAULT_LLM_CONFIG: { model: "gpt-4o", maxCalls: 10 },
}));

vi.mock("../src/analysis/deep-promoter.js", () => ({
  runDeepPromotion: vi.fn().mockResolvedValue({ count: 0, entries: [] }),
}));

vi.mock("../src/analysis/rem-reflector.js", () => ({
  runRemReflection: vi.fn().mockResolvedValue(null),
  isSunday: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/tracking/recall-tracker.js", () => ({
  RecallTracker: vi.fn().mockImplementation(() => ({
    getStats: vi.fn().mockResolvedValue([]),
    readLog: vi.fn().mockResolvedValue([]),
  })),
}));

const mockDetectSupersessionProposals = vi.fn();
vi.mock("../src/analysis/supersession-detector.js", () => ({
  detectSupersessionProposals: (...args: unknown[]) =>
    mockDetectSupersessionProposals(...args),
}));

const mockApplySupersessionProposals = vi.fn();
vi.mock("../src/analysis/supersession-applier.js", () => ({
  applySupersessionProposals: (...args: unknown[]) =>
    mockApplySupersessionProposals(...args),
}));

const memories = [
  {
    id: "old-a",
    text: "之前使用 A 方法處理 session cleanup",
    category: "decision",
    scope: "global",
    importance: 0.5,
    timestamp: 1,
    metadata: "{}",
    vector: [1, 0, 0],
  },
  {
    id: "new-b",
    text: "2026-07-06 起改用 B 方法處理 session cleanup",
    category: "decision",
    scope: "global",
    importance: 0.6,
    timestamp: 2,
    metadata: "{}",
    vector: [0.9, 0.1, 0],
  },
];

const proposal: SupersessionProposal = {
  old: memories[0],
  current: memories[1],
  canonicalKey: "workflow:session-cleanup",
  reason: "method_migration",
  confidence: "high",
  evidence: ["test"],
  action: "mark_superseded",
};

describe("dream-engine supersession integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllMemories.mockResolvedValue(memories);
    mockDetectSupersessionProposals.mockReturnValue([proposal]);
    mockApplySupersessionProposals.mockResolvedValue({
      applied: 1,
      skipped: 0,
      errors: [],
      entries: [
        {
          oldId: "old-a",
          currentId: "new-b",
          reason: "method_migration",
          action: "mark_superseded",
        },
      ],
    });
  });

  it("reports proposals in dry-run without applying", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    const result = await runDream({ dryRun: true, skipDeep: true, skipRem: true });

    expect(mockDetectSupersessionProposals).toHaveBeenCalledWith(memories);
    expect(mockApplySupersessionProposals).not.toHaveBeenCalled();
    expect(result.report.supersession.count).toBe(1);
  });

  it("does not apply supersession for --no-dry-run alone", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    await runDream({ dryRun: false, skipDeep: true, skipRem: true });

    expect(mockApplySupersessionProposals).not.toHaveBeenCalled();
  });

  it("applies only when supersessionApply is enabled", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    const result = await runDream({
      dryRun: false,
      supersessionApply: true,
      supersessionMaxChangesPerRun: 7,
      skipDeep: true,
      skipRem: true,
    });

    expect(mockApplySupersessionProposals).toHaveBeenCalledWith(
      expect.objectContaining({ updateMemoryMetadata: expect.any(Function) }),
      [proposal],
      { maxChanges: 7 },
    );
    expect(result.report.supersession.applied?.count).toBe(1);
  });
});
