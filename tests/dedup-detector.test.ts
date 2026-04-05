import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  jaccardSimilarity,
  extractKeywords,
  detectDuplicates,
} from "../src/analysis/dedup-detector.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

describe("cosineSimilarity", () => {
  it("should return 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 6);
  });

  it("should return 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 6);
  });

  it("should return -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 6);
  });

  it("should handle zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it("should return 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("should return 0 for different-length vectors", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("should compute correctly for known vectors", () => {
    // cos([1,2,3], [4,5,6]) = 32 / (sqrt(14) * sqrt(77))
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(expected, 6);
  });
});

describe("jaccardSimilarity", () => {
  it("should return 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBeCloseTo(1.0);
  });

  it("should return 0 for disjoint sets", () => {
    expect(
      jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"])),
    ).toBeCloseTo(0.0);
  });

  it("should return 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("should compute correctly for overlapping sets", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} → 2/4 = 0.5
    expect(
      jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])),
    ).toBeCloseTo(0.5);
  });
});

describe("extractKeywords", () => {
  it("should extract lowercased words > 1 char", () => {
    const kw = extractKeywords("Hello World I am a Test");
    expect(kw.has("hello")).toBe(true);
    expect(kw.has("world")).toBe(true);
    expect(kw.has("test")).toBe(true);
    expect(kw.has("am")).toBe(true);
    // single char filtered out
    expect(kw.has("i")).toBe(false);
    expect(kw.has("a")).toBe(false);
  });

  it("should handle Chinese text", () => {
    const kw = extractKeywords("用戶喜歡 TypeScript 和 React");
    expect(kw.has("typescript")).toBe(true);
    expect(kw.has("react")).toBe(true);
    expect(kw.has("用戶喜歡")).toBe(true);
  });
});

describe("detectDuplicates", () => {
  function makeRecord(
    id: string,
    text: string,
    vector: number[],
    importance = 0.5,
  ): MemoryRecord {
    return {
      id,
      text,
      category: "fact",
      scope: "global",
      importance,
      timestamp: Date.now(),
      metadata: "{}",
      vector,
    };
  }

  it("should detect identical vectors as duplicates", () => {
    const v = [1, 0, 0, 0, 0];
    const records = [
      makeRecord("a", "user likes TypeScript programming", v),
      makeRecord("b", "user likes TypeScript programming language", v),
    ];
    const pairs = detectDuplicates(records, {
      vectorThreshold: 0.9,
      keywordMinOverlap: 0.3,
    });
    expect(pairs.length).toBe(1);
    expect(pairs[0].similarity).toBeCloseTo(1.0);
  });

  it("should not detect orthogonal vectors as duplicates", () => {
    const records = [
      makeRecord("a", "user likes cats", [1, 0, 0]),
      makeRecord("b", "user likes dogs", [0, 1, 0]),
    ];
    const pairs = detectDuplicates(records, { vectorThreshold: 0.9 });
    expect(pairs.length).toBe(0);
  });

  it("should skip records without vectors", () => {
    const records = [
      makeRecord("a", "some text", []),
      makeRecord("b", "some text too", [1, 2, 3]),
    ];
    const pairs = detectDuplicates(records);
    expect(pairs.length).toBe(0);
  });

  it("should prefer higher importance for keep", () => {
    const v = [1, 1, 1];
    const records = [
      makeRecord("lo", "user prefers dark mode theme", v, 0.3),
      makeRecord("hi", "user prefers dark mode setting", v, 0.9),
    ];
    const pairs = detectDuplicates(records, {
      vectorThreshold: 0.9,
      keywordMinOverlap: 0.3,
    });
    expect(pairs.length).toBe(1);
    expect(pairs[0].keep.id).toBe("hi");
    expect(pairs[0].merge.id).toBe("lo");
  });
});
