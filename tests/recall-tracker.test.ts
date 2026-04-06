import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RecallTracker } from "../src/tracking/recall-tracker.js";
import type { RecallLogEntry } from "../src/tracking/recall-tracker.js";

let tmpDir: string;
let tracker: RecallTracker;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "recall-test-"));
  tracker = new RecallTracker(tmpDir);
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────

function makeEntry(overrides?: Partial<RecallLogEntry>): RecallLogEntry {
  return {
    ts: Date.now(),
    query: "test query",
    hits: [{ id: "mem-1", score: 0.9 }],
    ...overrides,
  };
}

const DAY_MS = 86_400_000;

// ── Tests ────────────────────────────────────────────

describe("RecallTracker", () => {
  describe("record + readLog", () => {
    it("should write and read back entries", async () => {
      const entry = makeEntry();
      await tracker.record(entry);

      const entries = await tracker.readLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].query).toBe("test query");
      expect(entries[0].hits).toHaveLength(1);
      expect(entries[0].hits[0].id).toBe("mem-1");
    });

    it("should append multiple entries", async () => {
      await tracker.record(makeEntry({ query: "q1" }));
      await tracker.record(makeEntry({ query: "q2" }));
      await tracker.record(makeEntry({ query: "q3" }));

      const entries = await tracker.readLog();
      expect(entries).toHaveLength(3);
    });

    it("should return empty array for non-existent log", async () => {
      const entries = await tracker.readLog();
      expect(entries).toEqual([]);
    });

    it("should filter by since parameter", async () => {
      const now = Date.now();
      await tracker.record(makeEntry({ ts: now - 2 * DAY_MS, query: "old" }));
      await tracker.record(makeEntry({ ts: now, query: "new" }));

      const entries = await tracker.readLog(now - DAY_MS);
      expect(entries).toHaveLength(1);
      expect(entries[0].query).toBe("new");
    });
  });

  describe("getStats", () => {
    it("should return empty array for empty log", async () => {
      const stats = await tracker.getStats();
      expect(stats).toEqual([]);
    });

    it("should compute correct totalRecalls", async () => {
      await tracker.record(makeEntry({ hits: [{ id: "m1", score: 0.8 }] }));
      await tracker.record(makeEntry({ hits: [{ id: "m1", score: 0.9 }] }));
      await tracker.record(makeEntry({ hits: [{ id: "m2", score: 0.5 }] }));

      const stats = await tracker.getStats();
      const m1 = stats.find((s) => s.memoryId === "m1")!;
      const m2 = stats.find((s) => s.memoryId === "m2")!;

      expect(m1.totalRecalls).toBe(2);
      expect(m2.totalRecalls).toBe(1);
    });

    it("should compute correct uniqueQueries", async () => {
      await tracker.record(
        makeEntry({ query: "alpha", hits: [{ id: "m1", score: 0.8 }] }),
      );
      await tracker.record(
        makeEntry({ query: "beta", hits: [{ id: "m1", score: 0.7 }] }),
      );
      await tracker.record(
        makeEntry({ query: "alpha", hits: [{ id: "m1", score: 0.9 }] }),
      );

      const stats = await tracker.getStats();
      const m1 = stats.find((s) => s.memoryId === "m1")!;
      expect(m1.uniqueQueries).toBe(2); // "alpha" and "beta"
      expect(m1.totalRecalls).toBe(3);
    });

    it("should compute correct avgScore", async () => {
      await tracker.record(makeEntry({ hits: [{ id: "m1", score: 0.6 }] }));
      await tracker.record(makeEntry({ hits: [{ id: "m1", score: 0.8 }] }));

      const stats = await tracker.getStats();
      expect(stats[0].avgScore).toBeCloseTo(0.7, 6);
    });

    it("should compute correct lastRecalledAt", async () => {
      const now = Date.now();
      await tracker.record(
        makeEntry({ ts: now - DAY_MS, hits: [{ id: "m1", score: 0.5 }] }),
      );
      await tracker.record(
        makeEntry({ ts: now, hits: [{ id: "m1", score: 0.5 }] }),
      );

      const stats = await tracker.getStats();
      expect(stats[0].lastRecalledAt).toBe(now);
    });

    it("should compute correct daySpan", async () => {
      const now = Date.now();
      // Spread across 3 distinct days
      await tracker.record(
        makeEntry({ ts: now - 3 * DAY_MS, hits: [{ id: "m1", score: 0.5 }] }),
      );
      await tracker.record(
        makeEntry({ ts: now - 1 * DAY_MS, hits: [{ id: "m1", score: 0.5 }] }),
      );
      await tracker.record(
        makeEntry({ ts: now, hits: [{ id: "m1", score: 0.5 }] }),
      );

      const stats = await tracker.getStats();
      expect(stats[0].daySpan).toBe(3);
    });

    it("should respect since filter", async () => {
      const now = Date.now();
      await tracker.record(
        makeEntry({ ts: now - 10 * DAY_MS, hits: [{ id: "m1", score: 0.5 }] }),
      );
      await tracker.record(
        makeEntry({ ts: now, hits: [{ id: "m1", score: 0.9 }] }),
      );

      const stats = await tracker.getStats({ since: now - DAY_MS });
      expect(stats[0].totalRecalls).toBe(1);
      expect(stats[0].avgScore).toBeCloseTo(0.9, 6);
    });

    it("should respect minRecalls filter", async () => {
      await tracker.record(makeEntry({ hits: [{ id: "m1", score: 0.5 }] }));
      await tracker.record(makeEntry({ hits: [{ id: "m2", score: 0.5 }] }));
      await tracker.record(makeEntry({ hits: [{ id: "m2", score: 0.5 }] }));
      await tracker.record(makeEntry({ hits: [{ id: "m2", score: 0.5 }] }));

      const stats = await tracker.getStats({ minRecalls: 3 });
      expect(stats).toHaveLength(1);
      expect(stats[0].memoryId).toBe("m2");
    });

    it("should sort by totalRecalls descending", async () => {
      await tracker.record(makeEntry({ hits: [{ id: "low", score: 0.5 }] }));
      for (let i = 0; i < 5; i++) {
        await tracker.record(makeEntry({ hits: [{ id: "high", score: 0.9 }] }));
      }

      const stats = await tracker.getStats();
      expect(stats[0].memoryId).toBe("high");
      expect(stats[1].memoryId).toBe("low");
    });
  });

  describe("prune", () => {
    it("should delete entries older than maxAgeDays", async () => {
      const now = Date.now();
      await tracker.record(makeEntry({ ts: now - 100 * DAY_MS, query: "old" }));
      await tracker.record(makeEntry({ ts: now, query: "new" }));

      const pruned = await tracker.prune(90);
      expect(pruned).toBe(1);

      const remaining = await tracker.readLog();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].query).toBe("new");
    });

    it("should return 0 when nothing to prune", async () => {
      await tracker.record(makeEntry({ ts: Date.now() }));
      const pruned = await tracker.prune(90);
      expect(pruned).toBe(0);
    });

    it("should handle empty log", async () => {
      const pruned = await tracker.prune(90);
      expect(pruned).toBe(0);
    });

    it("should handle pruning all entries", async () => {
      const now = Date.now();
      await tracker.record(makeEntry({ ts: now - 200 * DAY_MS }));
      await tracker.record(makeEntry({ ts: now - 150 * DAY_MS }));

      const pruned = await tracker.prune(90);
      expect(pruned).toBe(2);

      const remaining = await tracker.readLog();
      expect(remaining).toEqual([]);
    });
  });

  describe("recordFromToolResult", () => {
    it("should extract hits from tool result payload", () => {
      const entry = tracker.recordFromToolResult(
        { result: { memories: [{ id: "m1", score: 0.85 }, { id: "m2", score: 0.7 }] } },
        "search query",
        "agent-1",
      );

      expect(entry).not.toBeNull();
      expect(entry!.query).toBe("search query");
      expect(entry!.agentId).toBe("agent-1");
      expect(entry!.hits).toHaveLength(2);
      expect(entry!.hits[0]).toEqual({ id: "m1", score: 0.85 });
    });

    it("should return null for empty memories", () => {
      const entry = tracker.recordFromToolResult(
        { result: { memories: [] } },
        "q",
      );
      expect(entry).toBeNull();
    });

    it("should return null for missing result", () => {
      const entry = tracker.recordFromToolResult({}, "q");
      expect(entry).toBeNull();
    });
  });

  describe("recordFromMessage", () => {
    it("should extract from message content object", () => {
      const entry = tracker.recordFromMessage({
        toolName: "memory_recall",
        content: { query: "find stuff", memories: [{ id: "m1", score: 0.9 }] },
      });

      expect(entry).not.toBeNull();
      expect(entry!.query).toBe("find stuff");
      expect(entry!.hits).toHaveLength(1);
    });

    it("should extract from message content string", () => {
      const entry = tracker.recordFromMessage({
        toolName: "memory_recall",
        content: JSON.stringify({
          query: "find stuff",
          memories: [{ id: "m1", score: 0.9 }],
        }),
      });

      expect(entry).not.toBeNull();
      expect(entry!.query).toBe("find stuff");
    });

    it("should return null for non-memory_recall messages", () => {
      const entry = tracker.recordFromMessage({
        toolName: "other_tool",
        content: {},
      });
      expect(entry).toBeNull();
    });

    it("should return null for malformed content", () => {
      const entry = tracker.recordFromMessage({
        toolName: "memory_recall",
        content: "not-json{{{",
      });
      expect(entry).toBeNull();
    });
  });
});
