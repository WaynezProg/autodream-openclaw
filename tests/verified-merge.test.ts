import { describe, expect, it, vi } from "vitest";
import { applyVerifiedMerge } from "../src/analysis/verified-merge.js";
import type { DedupPair } from "../src/analysis/dedup-detector.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

function memory(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text: `${id} same memory text`,
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: 1,
    metadata: "{}",
    vector: [1, 0, 0],
    ...overrides,
  };
}

function pair(overrides: Partial<{ a: MemoryRecord; b: MemoryRecord }> = {}): DedupPair {
  const a = overrides.a ?? memory("keep");
  const b = overrides.b ?? memory("delete");
  return { a, b, keep: a, merge: b, similarity: 1, keywordOverlap: 1 };
}

function adapter(readBack = memory("keep", { text: "merged memory" })) {
  return {
    getMemoryById: vi.fn().mockResolvedValue(readBack),
    updateMemoryTextAndVector: vi.fn().mockResolvedValue(true),
    deleteMemory: vi.fn().mockResolvedValue(true),
  };
}

describe("applyVerifiedMerge", () => {
  it("rejects cross-scope and cross-category pairs before mutation", async () => {
    for (const unsafePair of [
      pair({ b: memory("delete", { scope: "agent:tech" }) }),
      pair({ b: memory("delete", { category: "decision" }) }),
    ]) {
      const db = adapter();
      const result = await applyVerifiedMerge({
        adapter: db,
        merge: { pair: unsafePair, keepId: "keep", originalsToDelete: ["delete"], mergedText: "merged memory" },
        embedder: { embed: vi.fn().mockResolvedValue([1, 0, 0]) },
      });
      expect(result.status).toBe("rejected");
      expect(db.updateMemoryTextAndVector).not.toHaveBeenCalled();
      expect(db.deleteMemory).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["embed failure", { embed: vi.fn().mockRejectedValue(new Error("embed")) }, adapter()],
    ["dimension mismatch", { embed: vi.fn().mockResolvedValue([1, 0]) }, adapter()],
    ["update false", { embed: vi.fn().mockResolvedValue([1, 0, 0]) }, adapter()],
    ["read-back mismatch", { embed: vi.fn().mockResolvedValue([1, 0, 0]) }, adapter(memory("keep", { text: "wrong" }))],
  ])("deletes nothing on %s", async (name, embedder, db) => {
    if (name === "update false") db.updateMemoryTextAndVector.mockResolvedValue(false);
    const sourcePair = pair();
    const result = await applyVerifiedMerge({
      adapter: db,
      merge: { pair: sourcePair, keepId: "keep", originalsToDelete: ["delete"], mergedText: "merged memory" },
      embedder,
    });
    expect(result.status).toBe("failed");
    expect(db.deleteMemory).not.toHaveBeenCalled();
  });

  it("deletes the duplicate only after verified write/read-back", async () => {
    const db = adapter();
    const sourcePair = pair();
    const result = await applyVerifiedMerge({
      adapter: db,
      merge: { pair: sourcePair, keepId: "keep", originalsToDelete: ["delete"], mergedText: "merged memory" },
      embedder: { embed: vi.fn().mockResolvedValue([1, 0, 0]) },
    });
    expect(result.status).toBe("applied");
    expect(db.updateMemoryTextAndVector.mock.invocationCallOrder[0]).toBeLessThan(
      db.deleteMemory.mock.invocationCallOrder[0],
    );
  });
});
