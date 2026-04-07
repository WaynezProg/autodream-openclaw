import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DreamEngineConfig } from "../src/dream-engine.js";

/**
 * Test re-embed logic in isolation by mocking the LanceDB adapter and LLM.
 * We import runDream dynamically after mocking dependencies.
 */

// Mock LanceDB adapter
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockGetTableSchema = vi.fn().mockResolvedValue(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"]);
const mockListAllMemories = vi.fn();
const mockUpdateMemoryText = vi.fn().mockResolvedValue(true);
const mockUpdateMemoryTextAndVector = vi.fn().mockResolvedValue(true);
const mockDeleteMemory = vi.fn().mockResolvedValue(true);

vi.mock("../src/lancedb-adapter.js", () => ({
  LanceDbAdapter: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    getTableSchema: mockGetTableSchema,
    listAllMemories: mockListAllMemories,
    updateMemoryText: mockUpdateMemoryText,
    updateMemoryTextAndVector: mockUpdateMemoryTextAndVector,
    deleteMemory: mockDeleteMemory,
  })),
}));

// Mock dedup-detector to return controlled pairs
const mockDetectDuplicates = vi.fn().mockReturnValue([]);
vi.mock("../src/analysis/dedup-detector.js", () => ({
  detectDuplicates: (...args: unknown[]) => mockDetectDuplicates(...args),
}));

// Mock other analysis modules
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

// Mock dedup-merger to return controlled merge results
const mockMergeWithLlm = vi.fn().mockResolvedValue([]);
vi.mock("../src/analysis/dedup-merger.js", () => ({
  mergeWithLlm: (...args: unknown[]) => mockMergeWithLlm(...args),
}));

// Mock LLM helper
vi.mock("../src/analysis/llm-helper.js", () => ({
  LlmHelper: vi.fn().mockImplementation(() => ({
    used: 0,
  })),
  DEFAULT_LLM_CONFIG: { model: "gpt-4o", maxCalls: 10 },
}));

// Mock deep promoter and REM reflector
vi.mock("../src/analysis/deep-promoter.js", () => ({
  runDeepPromotion: vi.fn().mockResolvedValue({ count: 0, entries: [] }),
}));

vi.mock("../src/analysis/rem-reflector.js", () => ({
  runRemReflection: vi.fn().mockResolvedValue(null),
  isSunday: vi.fn().mockReturnValue(false),
}));

// Mock recall tracker
vi.mock("../src/tracking/recall-tracker.js", () => ({
  RecallTracker: vi.fn().mockImplementation(() => ({
    getStats: vi.fn().mockResolvedValue([]),
    readLog: vi.fn().mockResolvedValue([]),
  })),
}));

function makeMem(id: string, text: string, vector: number[], importance = 0.5) {
  return {
    id,
    text,
    category: "preference",
    scope: "global",
    importance,
    timestamp: Date.now(),
    metadata: "{}",
    vector,
  };
}

function makeDedupPair(a: ReturnType<typeof makeMem>, b: ReturnType<typeof makeMem>, similarity: number) {
  const keep = a.importance >= b.importance ? a : b;
  const merge = a.importance >= b.importance ? b : a;
  return { a, b, similarity, keywordOverlap: 0.6, keep, merge };
}

describe("dream-engine re-embed", () => {
  const mem1 = makeMem("mem-1", "user prefers dark mode", [1, 0, 0], 0.8);
  const mem2 = makeMem("mem-2", "user likes dark theme", [0.9, 0.1, 0], 0.5);

  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllMemories.mockResolvedValue([mem1, mem2]);
  });

  it("should re-embed merged memories when embedder is provided", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    // Set up merge result
    const mergeResult = {
      keepId: "mem-1",
      mergedText: "user prefers dark mode / dark theme",
      originalsToDelete: ["mem-2"],
    };
    mockMergeWithLlm.mockResolvedValueOnce([mergeResult]);
    mockDetectDuplicates.mockReturnValueOnce([makeDedupPair(mem1, mem2, 0.95)]);

    const newVector = [0.95, 0.05, 0.01];
    const embedder = {
      embed: vi.fn().mockResolvedValue(newVector),
    };

    const result = await runDream({
      dryRun: false,
      autoMergeDuplicates: true,
      embedder,
      llmProvider: "openai",
      llmApiKey: "test-key",
      skipDeep: true,
      skipRem: true,
    });

    // Embedder should have been called with merged text
    expect(embedder.embed).toHaveBeenCalledWith("user prefers dark mode / dark theme");

    // Should use updateMemoryTextAndVector (not just updateMemoryText)
    expect(mockUpdateMemoryTextAndVector).toHaveBeenCalledWith(
      "mem-1",
      "user prefers dark mode / dark theme",
      newVector,
    );
    expect(mockUpdateMemoryText).not.toHaveBeenCalled();

    // Report should show re-embedded count
    expect(result.report.reEmbedded).toBe(1);

    // Original should be deleted
    expect(mockDeleteMemory).toHaveBeenCalledWith("mem-2");
  });

  it("should fall back to text-only update when embedder fails", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    const mergeResult = {
      keepId: "mem-1",
      mergedText: "user prefers dark mode / dark theme",
      originalsToDelete: ["mem-2"],
    };
    mockMergeWithLlm.mockResolvedValueOnce([mergeResult]);
    mockDetectDuplicates.mockReturnValueOnce([makeDedupPair(mem1, mem2, 0.95)]);

    const embedder = {
      embed: vi.fn().mockRejectedValue(new Error("API rate limit")),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runDream({
      dryRun: false,
      autoMergeDuplicates: true,
      embedder,
      llmProvider: "openai",
      llmApiKey: "test-key",
      skipDeep: true,
      skipRem: true,
    });

    // Should fall back to text-only update
    expect(mockUpdateMemoryText).toHaveBeenCalledWith(
      "mem-1",
      "user prefers dark mode / dark theme",
    );
    expect(mockUpdateMemoryTextAndVector).not.toHaveBeenCalled();

    // Re-embed count should be 0 (failed)
    expect(result.report.reEmbedded).toBe(0);

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("re-embed failed"),
    );

    warnSpy.mockRestore();
  });

  it("should update text only when no embedder is configured", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    const mergeResult = {
      keepId: "mem-1",
      mergedText: "user prefers dark mode / dark theme",
      originalsToDelete: ["mem-2"],
    };
    mockMergeWithLlm.mockResolvedValueOnce([mergeResult]);
    mockDetectDuplicates.mockReturnValueOnce([makeDedupPair(mem1, mem2, 0.95)]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runDream({
      dryRun: false,
      autoMergeDuplicates: true,
      // No embedder provided
      llmProvider: "openai",
      llmApiKey: "test-key",
      skipDeep: true,
      skipRem: true,
    });

    // Should use text-only update
    expect(mockUpdateMemoryText).toHaveBeenCalledWith(
      "mem-1",
      "user prefers dark mode / dark theme",
    );
    expect(mockUpdateMemoryTextAndVector).not.toHaveBeenCalled();

    // Re-embed count should be 0
    expect(result.report.reEmbedded).toBe(0);

    // Should warn about missing embedder
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No embedder configured"),
    );

    warnSpy.mockRestore();
  });

  it("should not re-embed in dry-run mode", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    mockDetectDuplicates.mockReturnValueOnce([makeDedupPair(mem1, mem2, 0.95)]);

    const embedder = {
      embed: vi.fn().mockResolvedValue([0.95, 0.05, 0.01]),
    };

    const result = await runDream({
      dryRun: true,
      autoMergeDuplicates: true,
      embedder,
      skipDeep: true,
      skipRem: true,
    });

    // Nothing should be called in dry-run
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(mockUpdateMemoryTextAndVector).not.toHaveBeenCalled();
    expect(mockUpdateMemoryText).not.toHaveBeenCalled();
    expect(result.report.reEmbedded).toBe(0);
  });

  it("should re-embed multiple merges and count correctly", async () => {
    const { runDream } = await import("../src/dream-engine.js");

    const m1 = makeMem("m1", "fact a", [1, 0], 0.8);
    const m2 = makeMem("m2", "fact b", [1, 0], 0.5);
    const m3 = makeMem("m3", "fact c", [0, 1], 0.7);
    const m4 = makeMem("m4", "fact d", [0, 1], 0.4);
    mockListAllMemories.mockResolvedValueOnce([m1, m2, m3, m4]);

    mockDetectDuplicates.mockReturnValueOnce([
      makeDedupPair(m1, m2, 0.99),
      makeDedupPair(m3, m4, 0.98),
    ]);

    mockMergeWithLlm.mockResolvedValueOnce([
      { keepId: "m1", mergedText: "merged-ab", originalsToDelete: ["m2"] },
      { keepId: "m3", mergedText: "merged-cd", originalsToDelete: ["m4"] },
    ]);

    let callCount = 0;
    const embedder = {
      embed: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve([callCount, 0]);
      }),
    };

    const result = await runDream({
      dryRun: false,
      autoMergeDuplicates: true,
      embedder,
      llmProvider: "openai",
      llmApiKey: "test-key",
      skipDeep: true,
      skipRem: true,
    });

    expect(embedder.embed).toHaveBeenCalledTimes(2);
    expect(mockUpdateMemoryTextAndVector).toHaveBeenCalledTimes(2);
    expect(result.report.reEmbedded).toBe(2);
  });
});
