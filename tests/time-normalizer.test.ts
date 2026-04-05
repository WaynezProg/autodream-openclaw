import { describe, it, expect } from "vitest";
import { detectRelativeTime } from "../src/analysis/time-normalizer.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

function makeRecord(id: string, text: string, timestamp: number): MemoryRecord {
  return {
    id,
    text,
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp,
    metadata: "{}",
    vector: [],
  };
}

// Fixed base: 2026-04-05 00:00:00 UTC
const BASE = Date.UTC(2026, 3, 5); // month is 0-indexed

function formatUTC(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("detectRelativeTime", () => {
  it("should detect 昨天 and resolve to timestamp - 1 day", () => {
    const entries = detectRelativeTime([makeRecord("1", "昨天開了會議", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("昨天");
    expect(entries[0].resolved).toBe("2026-04-04");
    expect(entries[0].confidence).toBe("high");
    expect(entries[0].newText).toBe("2026-04-04開了會議");
  });

  it("should detect 前天 and resolve to timestamp - 2 days", () => {
    const entries = detectRelativeTime([makeRecord("2", "前天部署了新版本", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("前天");
    expect(entries[0].resolved).toBe("2026-04-03");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect N天前", () => {
    const entries = detectRelativeTime([makeRecord("3", "3天前修了 bug", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("3天前");
    expect(entries[0].resolved).toBe("2026-04-02");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect 上週", () => {
    const entries = detectRelativeTime([makeRecord("4", "上週討論了架構", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("上週");
    expect(entries[0].resolved).toBe("2026-03-29");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect 上個月", () => {
    const entries = detectRelativeTime([makeRecord("5", "上個月的 sprint 目標", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("上個月");
    expect(entries[0].resolved).toBe("2026-03-06");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect 2週前", () => {
    const entries = detectRelativeTime([makeRecord("6", "2週前做了重構", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("2週前");
    expect(entries[0].resolved).toBe("2026-03-22");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect yesterday (English)", () => {
    const entries = detectRelativeTime([makeRecord("7", "Fixed the bug yesterday", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("yesterday");
    expect(entries[0].resolved).toBe("2026-04-04");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect N days ago (English)", () => {
    const entries = detectRelativeTime([makeRecord("8", "Deployed 3 days ago", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("3 days ago");
    expect(entries[0].resolved).toBe("2026-04-02");
    expect(entries[0].confidence).toBe("high");
  });

  it("should detect last week (English)", () => {
    const entries = detectRelativeTime([makeRecord("9", "Discussed last week", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("last week");
    expect(entries[0].resolved).toBe("2026-03-29");
    expect(entries[0].confidence).toBe("high");
  });

  it("should flag 最近 as low confidence without resolving", () => {
    const entries = detectRelativeTime([makeRecord("10", "最近在研究 Rust", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("最近");
    expect(entries[0].confidence).toBe("low");
    expect(entries[0].resolved).toBe("");
    expect(entries[0].newText).toBe("最近在研究 Rust");
  });

  it("should flag recently as low confidence", () => {
    const entries = detectRelativeTime([makeRecord("11", "User recently migrated to Next.js", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].confidence).toBe("low");
    expect(entries[0].resolved).toBe("");
  });

  it("should not produce entries for text without time expressions", () => {
    const entries = detectRelativeTime([makeRecord("12", "User prefers dark mode", BASE)]);
    expect(entries).toHaveLength(0);
  });

  it("should handle 今天 resolving to same day", () => {
    const entries = detectRelativeTime([makeRecord("13", "今天設定了 CI", BASE)]);
    expect(entries).toHaveLength(1);
    expect(entries[0].original).toBe("今天");
    expect(entries[0].resolved).toBe("2026-04-05");
    expect(entries[0].confidence).toBe("high");
  });

  it("should use memory.timestamp as base, not Date.now()", () => {
    const oldBase = Date.UTC(2025, 0, 15); // 2025-01-15
    const entries = detectRelativeTime([makeRecord("14", "昨天開會", oldBase)]);
    expect(entries[0].resolved).toBe("2025-01-14");
  });
});
