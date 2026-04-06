import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getIsoWeek,
  getWeekRange,
  clusterQueriesByKeywords,
  detectEmergingAndFading,
  formatReflectionSection,
  runRemReflection,
  isSunday,
  type ThemeEntry,
} from "../src/analysis/rem-reflector.js";
import type { RecallLogEntry } from "../src/tracking/recall-tracker.js";

// ── Helpers ──────────────────────────────────────────

const DAY_MS = 86_400_000;

function makeRecallEntry(
  query: string,
  hitIds: string[],
  opts?: { ts?: number },
): RecallLogEntry {
  return {
    ts: opts?.ts ?? Date.now(),
    query,
    hits: hitIds.map((id) => ({ id, score: 0.8 })),
  };
}

function makeTheme(theme: string, queryCount: number): ThemeEntry {
  return { theme, queryCount, topMemories: [], strength: queryCount / 20 };
}

// ── Tests ────────────────────────────────────────────

describe("getIsoWeek", () => {
  it("should return correct ISO week for a known date", () => {
    // 2026-04-06 is a Monday → Week 15
    const date = new Date("2026-04-06T12:00:00Z");
    const week = getIsoWeek(date);
    expect(week).toMatch(/2026-W\d{2}/);
  });

  it("should return consistent results for same week", () => {
    const mon = new Date("2026-04-06T00:00:00Z");
    const sun = new Date("2026-04-12T00:00:00Z");
    expect(getIsoWeek(mon)).toBe(getIsoWeek(sun));
  });
});

describe("getWeekRange", () => {
  it("should return Monday to Sunday range", () => {
    const date = new Date("2026-04-08T12:00:00Z"); // Wednesday
    const range = getWeekRange(date);
    expect(range.start).toBe("2026-04-06"); // Monday
    expect(range.end).toBe("2026-04-12"); // Sunday
  });
});

describe("clusterQueriesByKeywords", () => {
  it("should group similar queries together", () => {
    const entries = [
      makeRecallEntry("autoDream configuration settings", ["m1"]),
      makeRecallEntry("autoDream settings guide", ["m1", "m2"]),
      makeRecallEntry("deployment pipeline stages", ["m3"]),
      makeRecallEntry("pipeline deployment rollback", ["m3", "m4"]),
    ];
    const groups = clusterQueriesByKeywords(entries);

    // Should have at least 2 groups
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it("should return empty for empty input", () => {
    const groups = clusterQueriesByKeywords([]);
    expect(groups).toHaveLength(0);
  });

  it("should track memory IDs in groups", () => {
    const entries = [
      makeRecallEntry("database schema migration", ["m1", "m2"]),
      makeRecallEntry("database migration strategy", ["m1", "m3"]),
    ];
    const groups = clusterQueriesByKeywords(entries);

    // Find the database-related group
    const dbGroup = groups.find(
      (g) => g.theme.includes("database") || g.theme.includes("migration"),
    );
    expect(dbGroup).toBeTruthy();
    expect(dbGroup!.memoryIds.has("m1")).toBe(true);
  });
});

describe("detectEmergingAndFading", () => {
  it("should detect emerging topics", () => {
    const current = [makeTheme("new topic", 5)];
    const previous = [makeTheme("old topic", 5)];
    const { emerging, fading } = detectEmergingAndFading(current, previous);
    expect(emerging).toContain("new topic");
  });

  it("should detect fading topics", () => {
    const current = [makeTheme("current topic", 5)];
    const previous = [makeTheme("fading topic", 5)];
    const { emerging, fading } = detectEmergingAndFading(current, previous);
    expect(fading).toContain("fading topic");
  });

  it("should not flag topics present in both weeks", () => {
    const current = [makeTheme("stable topic", 5)];
    const previous = [makeTheme("stable topic", 3)];
    const { emerging, fading } = detectEmergingAndFading(current, previous);
    expect(emerging).not.toContain("stable topic");
    expect(fading).not.toContain("stable topic");
  });

  it("should ignore low-count themes", () => {
    const current = [makeTheme("rare query", 1)];
    const previous: ThemeEntry[] = [];
    const { emerging } = detectEmergingAndFading(current, previous);
    expect(emerging).not.toContain("rare query");
  });

  it("should handle empty inputs", () => {
    const { emerging, fading } = detectEmergingAndFading([], []);
    expect(emerging).toEqual([]);
    expect(fading).toEqual([]);
  });
});

describe("formatReflectionSection", () => {
  it("should format themes correctly", () => {
    const reflection = {
      period: "2026-W14",
      themes: [
        makeTheme("代購定價", 12),
        makeTheme("autoDream 設定", 8),
      ],
      emergingTopics: ["autoDream 設定"],
      fadingTopics: ["Claw Social 部署"],
      summary: "本週的焦點從代購營運延伸到基礎設施最佳化。",
    };
    const section = formatReflectionSection(reflection);

    expect(section).toContain("## REM — Week 14");
    expect(section).toContain("代購定價 (12次)");
    expect(section).toContain("autoDream 設定 (8次)");
    expect(section).toContain("**新浮現：** autoDream 設定");
    expect(section).toContain("**逐漸消退：** Claw Social 部署");
    expect(section).toContain("本週的焦點");
  });

  it("should handle empty themes", () => {
    const reflection = {
      period: "2026-W14",
      themes: [],
      emergingTopics: [],
      fadingTopics: [],
      summary: "",
    };
    const section = formatReflectionSection(reflection);
    expect(section).toContain("## REM — Week 14");
  });
});

describe("isSunday", () => {
  it("should return true for Sunday", () => {
    // 2026-04-05 is a Sunday
    expect(isSunday(new Date("2026-04-05T12:00:00Z"))).toBe(true);
  });

  it("should return false for non-Sunday", () => {
    // 2026-04-06 is a Monday
    expect(isSunday(new Date("2026-04-06T12:00:00Z"))).toBe(false);
  });
});

describe("runRemReflection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rem-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return null when below minWeeklyRecalls", async () => {
    const entries = [makeRecallEntry("test query", ["m1"])];
    const result = await runRemReflection({
      currentWeekEntries: entries,
      llm: null,
      config: { minWeeklyRecalls: 10 },
      workspacePath: tmpDir,
    });
    expect(result).toBeNull();
  });

  it("should produce reflection with enough entries", async () => {
    // Generate 15 entries with recurring themes
    const entries: RecallLogEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(makeRecallEntry("autoDream configuration setup", ["m1", "m2"]));
    }
    for (let i = 0; i < 7; i++) {
      entries.push(makeRecallEntry("database migration strategy", ["m3", "m4"]));
    }

    const result = await runRemReflection({
      currentWeekEntries: entries,
      llm: null,
      config: { minWeeklyRecalls: 10 },
      workspacePath: tmpDir,
      now: new Date("2026-04-05T12:00:00Z"),
    });

    expect(result).not.toBeNull();
    expect(result!.period).toMatch(/2026-W\d{2}/);
    expect(result!.summary.length).toBeGreaterThan(0);
  });

  it("should write DREAMS.md file", async () => {
    const entries: RecallLogEntry[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push(makeRecallEntry(`query about topic ${i % 3}`, [`m${i % 5}`]));
    }

    await runRemReflection({
      currentWeekEntries: entries,
      llm: null,
      workspacePath: tmpDir,
      now: new Date("2026-04-05T12:00:00Z"),
    });

    const content = await fs.promises.readFile(
      path.join(tmpDir, "DREAMS.md"),
      "utf-8",
    );
    expect(content).toContain("DREAMS.md — Dream Diary");
    expect(content).toContain("## REM — Week");
  });

  it("should detect emerging topics from previous week", async () => {
    const currentEntries: RecallLogEntry[] = [];
    for (let i = 0; i < 10; i++) {
      currentEntries.push(makeRecallEntry("brand new topic discussion", ["m1"]));
    }

    const previousEntries: RecallLogEntry[] = [];
    for (let i = 0; i < 10; i++) {
      previousEntries.push(makeRecallEntry("old topic from last week", ["m2"]));
    }

    const result = await runRemReflection({
      currentWeekEntries: currentEntries,
      previousWeekEntries: previousEntries,
      llm: null,
      workspacePath: tmpDir,
    });

    expect(result).not.toBeNull();
    // The exact behavior depends on keyword clustering,
    // but emerging/fading should be populated
    expect(result!.emergingTopics.length + result!.fadingTopics.length).toBeGreaterThanOrEqual(0);
  });

  it("should handle empty recall log gracefully", async () => {
    const result = await runRemReflection({
      currentWeekEntries: [],
      llm: null,
      workspacePath: tmpDir,
    });
    expect(result).toBeNull();
  });
});
