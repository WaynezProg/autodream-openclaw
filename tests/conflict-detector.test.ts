import { describe, it, expect } from "vitest";
import { detectConflicts } from "../src/analysis/conflict-detector.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

/**
 * Helper: create a record with a given vector.
 * To control cosine similarity we use simple 2D unit-ish vectors.
 */
function makeRecord(
  id: string,
  text: string,
  opts?: {
    vector?: number[];
    scope?: string;
    category?: string;
  },
): MemoryRecord {
  return {
    id,
    text,
    category: opts?.category ?? "decision",
    scope: opts?.scope ?? "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: "{}",
    vector: opts?.vector ?? [1, 0.5],
  };
}

/**
 * Build two vectors with a target cosine similarity in the 0.60-0.85 range.
 * v1 = [1, 0], v2 = [cos(θ), sin(θ)] where θ = acos(targetSim)
 */
function vectorPair(targetSim: number): [number[], number[]] {
  const theta = Math.acos(targetSim);
  return [[1, 0], [Math.cos(theta), Math.sin(theta)]];
}

const [V_A, V_B] = vectorPair(0.75); // sim ≈ 0.75 — in the conflict range

describe("detectConflicts", () => {
  it("should detect enable-disable conflict", () => {
    const records = [
      makeRecord("1", "已啟用 dark mode", { vector: V_A }),
      makeRecord("2", "已關閉 dark mode", { vector: V_B }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ruleMatched).toBe("enable-disable");
  });

  it("should detect complete-incomplete conflict", () => {
    const records = [
      makeRecord("1", "migration 已完成", { vector: V_A }),
      makeRecord("2", "migration 尚未完成", { vector: V_B }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ruleMatched).toBe("complete-incomplete");
  });

  it("should detect use-avoid conflict", () => {
    const records = [
      makeRecord("1", "應該用 Prisma 做 ORM", { vector: V_A }),
      makeRecord("2", "避免 Prisma 做 ORM", { vector: V_B }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ruleMatched).toBe("use-avoid");
  });

  it("should detect value-conflict (same key, different value)", () => {
    const records = [
      makeRecord("1", "port: 3000", { vector: V_A }),
      makeRecord("2", "port: 8080", { vector: V_B }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ruleMatched).toBe("value-conflict");
    expect(pairs[0].reason).toContain("port");
  });

  it("should NOT detect conflict across different scopes", () => {
    const records = [
      makeRecord("1", "已啟用 dark mode", { vector: V_A, scope: "project-a" }),
      makeRecord("2", "已關閉 dark mode", { vector: V_B, scope: "project-b" }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(0);
  });

  it("should NOT detect conflict when similarity > 0.85 (dedup territory)", () => {
    // identical vectors → sim = 1.0
    const v = [1, 2, 3];
    const records = [
      makeRecord("1", "已啟用 dark mode", { vector: v }),
      makeRecord("2", "已關閉 dark mode", { vector: v }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(0);
  });

  it("should NOT detect conflict when similarity < 0.60 (unrelated)", () => {
    // orthogonal → sim ≈ 0
    const records = [
      makeRecord("1", "已啟用 dark mode", { vector: [1, 0] }),
      makeRecord("2", "已關閉 dark mode", { vector: [0, 1] }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(0);
  });

  it("should NOT detect conflict when text has no contradicting patterns", () => {
    const records = [
      makeRecord("1", "User likes TypeScript", { vector: V_A }),
      makeRecord("2", "User prefers React", { vector: V_B }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(0);
  });

  it("should NOT detect conflict across different categories", () => {
    const records = [
      makeRecord("1", "已啟用 dark mode", { vector: V_A, category: "preference" }),
      makeRecord("2", "已關閉 dark mode", { vector: V_B, category: "decision" }),
    ];
    const pairs = detectConflicts(records);
    expect(pairs).toHaveLength(0);
  });
});
