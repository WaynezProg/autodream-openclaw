import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeSignals,
  computeScore,
  selectCandidates,
  isAlreadyPromoted,
  appendPromotionSection,
  runDeepPromotion,
  DEFAULT_DEEP_CONFIG,
  type DeepPromotionConfig,
  type DeepPromotionEntry,
} from "../src/analysis/deep-promoter.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";
import type { RecallStats } from "../src/tracking/recall-tracker.js";

// ── Helpers ──────────────────────────────────────────

const DAY_MS = 86_400_000;

function makeMemory(id: string, opts?: Partial<MemoryRecord>): MemoryRecord {
  return {
    id,
    text: opts?.text ?? `Memory ${id} with some useful information and keywords about testing`,
    category: opts?.category ?? "fact",
    scope: opts?.scope ?? "global",
    importance: opts?.importance ?? 0.5,
    timestamp: opts?.timestamp ?? Date.now() - 7 * DAY_MS,
    metadata: opts?.metadata ?? "{}",
    vector: opts?.vector ?? [],
  };
}

function makeStats(memoryId: string, opts?: Partial<RecallStats>): RecallStats {
  return {
    memoryId,
    totalRecalls: opts?.totalRecalls ?? 5,
    uniqueQueries: opts?.uniqueQueries ?? 3,
    avgScore: opts?.avgScore ?? 0.85,
    lastRecalledAt: opts?.lastRecalledAt ?? Date.now() - DAY_MS,
    daySpan: opts?.daySpan ?? 4,
  };
}

// ── Tests ────────────────────────────────────────────

describe("computeSignals", () => {
  it("should compute frequency correctly", () => {
    const mem = makeMemory("m1");
    const stats = makeStats("m1", { totalRecalls: 5 });
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    // min(5/10, 1) = 0.5
    expect(signals.frequency).toBeCloseTo(0.5, 6);
  });

  it("should cap frequency at 1.0 for 10+ recalls", () => {
    const mem = makeMemory("m1");
    const stats = makeStats("m1", { totalRecalls: 15 });
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    expect(signals.frequency).toBeCloseTo(1.0, 6);
  });

  it("should use avgScore as relevance directly", () => {
    const mem = makeMemory("m1");
    const stats = makeStats("m1", { avgScore: 0.72 });
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    expect(signals.relevance).toBeCloseTo(0.72, 6);
  });

  it("should compute queryDiversity correctly", () => {
    const mem = makeMemory("m1");
    const stats = makeStats("m1", { uniqueQueries: 3 });
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    // min(3/5, 1) = 0.6
    expect(signals.queryDiversity).toBeCloseTo(0.6, 6);
  });

  it("should compute recency with exponential decay", () => {
    const mem = makeMemory("m1");
    const now = Date.now();
    // Last recalled 14 days ago = half life
    const stats = makeStats("m1", { lastRecalledAt: now - 14 * DAY_MS });
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    // exp(-ln2 * 14 / 14) = exp(-ln2) = 0.5
    expect(signals.recency).toBeCloseTo(0.5, 1);
  });

  it("should compute consolidation correctly", () => {
    const mem = makeMemory("m1");
    const stats = makeStats("m1", { daySpan: 7 });
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    // min(7/7, 1) = 1.0
    expect(signals.consolidation).toBeCloseTo(1.0, 6);
  });

  it("should compute richness from keyword count", () => {
    const mem = makeMemory("m1", {
      text: "apple banana cherry date elderberry fig grape hazelnut jujube kiwi lemon mango nectarine orange pear",
    });
    const stats = makeStats("m1");
    const signals = computeSignals(mem, stats, DEFAULT_DEEP_CONFIG);
    // 15 unique keywords → min(15/15, 1) = 1.0
    expect(signals.richness).toBeCloseTo(1.0, 1);
  });
});

describe("computeScore", () => {
  it("should compute weighted sum correctly", () => {
    const signals = {
      frequency: 1.0,
      relevance: 1.0,
      queryDiversity: 1.0,
      recency: 1.0,
      consolidation: 1.0,
      richness: 1.0,
    };
    const score = computeScore(signals);
    // 0.24 + 0.30 + 0.15 + 0.15 + 0.10 + 0.06 = 1.0
    expect(score).toBeCloseTo(1.0, 6);
  });

  it("should compute partial score correctly", () => {
    const signals = {
      frequency: 0.5,
      relevance: 0.8,
      queryDiversity: 0.6,
      recency: 0.5,
      consolidation: 0.4,
      richness: 0.3,
    };
    const expected =
      0.5 * 0.24 + 0.8 * 0.30 + 0.6 * 0.15 + 0.5 * 0.15 + 0.4 * 0.10 + 0.3 * 0.06;
    expect(computeScore(signals)).toBeCloseTo(expected, 6);
  });

  it("should return 0 for all-zero signals", () => {
    const signals = {
      frequency: 0,
      relevance: 0,
      queryDiversity: 0,
      recency: 0,
      consolidation: 0,
      richness: 0,
    };
    expect(computeScore(signals)).toBe(0);
  });
});

describe("selectCandidates", () => {
  it("should exclude memories from non-promotable scopes", () => {
    const memories = [
      makeMemory("m1", { scope: "agent:kurisu" }),
      makeMemory("m2", { scope: "personal" }),
      makeMemory("m3", { scope: "global" }),
    ];
    const statsMap = new Map([
      ["m1", makeStats("m1", { totalRecalls: 10, uniqueQueries: 5, avgScore: 0.95, daySpan: 7 })],
      ["m2", makeStats("m2", { totalRecalls: 10, uniqueQueries: 5, avgScore: 0.95, daySpan: 7 })],
      ["m3", makeStats("m3", { totalRecalls: 10, uniqueQueries: 5, avgScore: 0.95, daySpan: 7 })],
    ]);
    const result = selectCandidates(memories, statsMap);
    // Only m3 (global) should be included
    expect(result).toHaveLength(1);
    expect(result[0].memory.id).toBe("m3");
  });

  it("should include memories from business scope", () => {
    const memories = [makeMemory("m1", { scope: "business" })];
    const statsMap = new Map([
      ["m1", makeStats("m1", { totalRecalls: 10, uniqueQueries: 5, avgScore: 0.95, daySpan: 7 })],
    ]);
    const result = selectCandidates(memories, statsMap);
    expect(result).toHaveLength(1);
  });

  it("should exclude memories below minRecallCount", () => {
    const memories = [makeMemory("m1")];
    const statsMap = new Map([["m1", makeStats("m1", { totalRecalls: 1 })]]);
    const result = selectCandidates(memories, statsMap, { ...DEFAULT_DEEP_CONFIG, minRecallCount: 3 });
    expect(result).toHaveLength(0);
  });

  it("should exclude memories below minUniqueQueries", () => {
    const memories = [makeMemory("m1")];
    const statsMap = new Map([["m1", makeStats("m1", { uniqueQueries: 1 })]]);
    const result = selectCandidates(memories, statsMap, { ...DEFAULT_DEEP_CONFIG, minUniqueQueries: 2 });
    expect(result).toHaveLength(0);
  });

  it("should exclude memories not recalled within maxAgeDays", () => {
    const memories = [makeMemory("m1")];
    const statsMap = new Map([
      ["m1", makeStats("m1", { lastRecalledAt: Date.now() - 60 * DAY_MS })],
    ]);
    const result = selectCandidates(memories, statsMap, { ...DEFAULT_DEEP_CONFIG, maxAgeDays: 30 });
    expect(result).toHaveLength(0);
  });

  it("should exclude memories below minScore threshold", () => {
    const memories = [makeMemory("m1")];
    // Very low stats → low score
    const statsMap = new Map([
      ["m1", makeStats("m1", {
        totalRecalls: 3,
        uniqueQueries: 2,
        avgScore: 0.1,
        daySpan: 1,
        lastRecalledAt: Date.now() - 20 * DAY_MS,
      })],
    ]);
    const result = selectCandidates(memories, statsMap, { ...DEFAULT_DEEP_CONFIG, minScore: 0.65 });
    expect(result).toHaveLength(0);
  });

  it("should respect maxPromotionsPerRun", () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory(`m${i}`, { text: `Memory ${i} with many words about different topics and keywords for testing richness` }),
    );
    const statsMap = new Map(
      memories.map((m) => [m.id, makeStats(m.id, { totalRecalls: 10, uniqueQueries: 5, avgScore: 0.95, daySpan: 7 })]),
    );
    const result = selectCandidates(memories, statsMap, { ...DEFAULT_DEEP_CONFIG, maxPromotionsPerRun: 3 });
    expect(result).toHaveLength(3);
  });

  it("should sort by score descending", () => {
    const m1 = makeMemory("m1", { text: "short" });
    const m2 = makeMemory("m2", { text: "a much longer text with many keywords about various different topics including some important facts" });
    const memories = [m1, m2];

    const statsMap = new Map([
      ["m1", makeStats("m1", { totalRecalls: 3, uniqueQueries: 2, avgScore: 0.5, daySpan: 2 })],
      ["m2", makeStats("m2", { totalRecalls: 10, uniqueQueries: 5, avgScore: 0.95, daySpan: 7 })],
    ]);

    const result = selectCandidates(memories, statsMap);
    expect(result.length).toBeGreaterThanOrEqual(1);
    if (result.length >= 2) {
      expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
    }
  });

  it("should return empty for memories without stats", () => {
    const memories = [makeMemory("m1")];
    const statsMap = new Map<string, RecallStats>();
    const result = selectCandidates(memories, statsMap);
    expect(result).toHaveLength(0);
  });
});

describe("isAlreadyPromoted", () => {
  it("should detect exact substring match", () => {
    const text = "The API key is stored in env";
    const existing = "Some content\n- **fact**: The API key is stored in env\n";
    expect(isAlreadyPromoted(text, existing)).toBe(true);
  });

  it("should detect high word overlap", () => {
    const text = "project uses typescript strict mode enabled";
    const existing = "project uses typescript strict mode enabled for safety";
    // existing is a superset → substring match should catch it
    expect(isAlreadyPromoted(text, existing)).toBe(true);
  });

  it("should return false for unrelated content", () => {
    const text = "Deploy to production every Friday";
    const existing = "The database schema uses PostgreSQL with migrations";
    expect(isAlreadyPromoted(text, existing)).toBe(false);
  });

  it("should return false for empty existing content", () => {
    expect(isAlreadyPromoted("some text", "")).toBe(false);
  });
});

describe("appendPromotionSection", () => {
  it("should create section when it does not exist", () => {
    const existing = "# MEMORY.md\n\nSome content\n";
    const entries: DeepPromotionEntry[] = [
      { memoryId: "m1", score: 0.85, refinedText: "Refined fact", category: "fact", date: "2026-04-07" },
    ];
    const result = appendPromotionSection(existing, entries);
    expect(result).toContain("## Deep Promotion（auto-promoted）");
    expect(result).toContain("**fact**（2026-04-07）：Refined fact");
    expect(result).toContain("`m1`");
    expect(result).toContain("0.8500");
  });

  it("should append to existing section", () => {
    const existing = [
      "# MEMORY.md",
      "",
      "## Deep Promotion（auto-promoted）",
      "",
      "- **fact**（2026-04-01）：Old entry",
      "  - 來源 memory ID: `m0`",
      "  - 升級分數: 0.7500",
      "",
    ].join("\n");

    const entries: DeepPromotionEntry[] = [
      { memoryId: "m1", score: 0.90, refinedText: "New entry", category: "decision", date: "2026-04-07" },
    ];
    const result = appendPromotionSection(existing, entries);

    // Should contain both entries
    expect(result).toContain("Old entry");
    expect(result).toContain("New entry");
    expect(result).toContain("`m1`");
  });

  it("should return original content for empty entries", () => {
    const existing = "# MEMORY.md\n";
    const result = appendPromotionSection(existing, []);
    expect(result).toBe(existing);
  });

  it("should handle multiple entries", () => {
    const existing = "# MEMORY.md\n";
    const entries: DeepPromotionEntry[] = [
      { memoryId: "m1", score: 0.85, refinedText: "First", category: "fact", date: "2026-04-07" },
      { memoryId: "m2", score: 0.75, refinedText: "Second", category: "decision", date: "2026-04-07" },
    ];
    const result = appendPromotionSection(existing, entries);
    expect(result).toContain("First");
    expect(result).toContain("Second");
  });
});

describe("runDeepPromotion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deep-promo-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty result when no candidates qualify", async () => {
    const result = await runDeepPromotion({
      memories: [makeMemory("m1")],
      recallStats: [makeStats("m1", { totalRecalls: 1 })], // below threshold
      llm: null,
      workspacePath: tmpDir,
    });
    expect(result.count).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it("should write MEMORY.md with promoted entries", async () => {
    const mem = makeMemory("m1", {
      text: "Important fact about the production deployment pipeline with multiple stages and rollback capability",
    });
    const stats = makeStats("m1", {
      totalRecalls: 10,
      uniqueQueries: 5,
      avgScore: 0.95,
      daySpan: 7,
      lastRecalledAt: Date.now() - DAY_MS,
    });

    const result = await runDeepPromotion({
      memories: [mem],
      recallStats: [stats],
      llm: null,
      workspacePath: tmpDir,
    });

    expect(result.count).toBe(1);
    expect(result.entries[0].memoryId).toBe("m1");

    // Verify file was written
    const content = await fs.promises.readFile(
      path.join(tmpDir, "MEMORY.md"),
      "utf-8",
    );
    expect(content).toContain("Deep Promotion");
    expect(content).toContain("m1");
  });

  it("should not re-promote already promoted memories", async () => {
    // Pre-create MEMORY.md with the memory text
    const memText = "Important fact about deployment pipeline";
    const memoryMd = [
      "# MEMORY.md",
      "",
      "## Deep Promotion（auto-promoted）",
      "",
      `- **fact**（2026-04-01）：${memText}`,
      "  - 來源 memory ID: `m1`",
      "  - 升級分數: 0.8500",
      "",
    ].join("\n");
    await fs.promises.writeFile(path.join(tmpDir, "MEMORY.md"), memoryMd, "utf-8");

    const mem = makeMemory("m1", { text: memText });
    const stats = makeStats("m1", {
      totalRecalls: 10,
      uniqueQueries: 5,
      avgScore: 0.95,
      daySpan: 7,
    });

    const result = await runDeepPromotion({
      memories: [mem],
      recallStats: [stats],
      llm: null,
      workspacePath: tmpDir,
    });

    expect(result.count).toBe(0);
  });

  it("should respect maxPromotionsPerRun in full pipeline", async () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory(`m${i}`, {
        text: `Unique fact number ${i} about topic ${i} with enough words to pass richness threshold for testing`,
      }),
    );
    const stats = memories.map((m) =>
      makeStats(m.id, {
        totalRecalls: 10,
        uniqueQueries: 5,
        avgScore: 0.95,
        daySpan: 7,
      }),
    );

    const result = await runDeepPromotion({
      memories,
      recallStats: stats,
      llm: null,
      config: { maxPromotionsPerRun: 2 },
      workspacePath: tmpDir,
    });

    expect(result.count).toBeLessThanOrEqual(2);
  });
});
