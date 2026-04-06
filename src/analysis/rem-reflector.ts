import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RecallLogEntry } from "../tracking/recall-tracker.js";
import type { LlmHelper } from "./llm-helper.js";
import { extractKeywords } from "./dedup-detector.js";

// ── Types ──────────────────────────────────────────────

export interface ThemeEntry {
  theme: string;
  queryCount: number;
  topMemories: string[];
  strength: number;
}

export interface RemReflection {
  period: string;
  themes: ThemeEntry[];
  emergingTopics: string[];
  fadingTopics: string[];
  summary: string;
}

export interface RemReflectionConfig {
  minWeeklyRecalls: number;
}

export const DEFAULT_REM_CONFIG: RemReflectionConfig = {
  minWeeklyRecalls: 10,
};

// ── Helpers ────────────────────────────────────────────

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Get ISO week string like "2026-W14" */
export function getIsoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Get Monday~Sunday date range for a given date's week */
export function getWeekRange(date: Date): { start: string; end: string } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayNum + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

// ── Theme extraction (keyword-based, LLM-enhanced) ─────

interface QueryGroup {
  theme: string;
  queries: string[];
  memoryIds: Map<string, number>; // id → hit count
}

/**
 * Group queries by keyword overlap into themes.
 * This is a simple clustering: extract keywords from each query,
 * then group queries that share significant keyword overlap.
 */
export function clusterQueriesByKeywords(
  entries: RecallLogEntry[],
): QueryGroup[] {
  const groups: QueryGroup[] = [];

  for (const entry of entries) {
    const queryKws = extractKeywords(entry.query);
    if (queryKws.size === 0) continue;

    // Find best matching group
    let bestGroup: QueryGroup | null = null;
    let bestOverlap = 0;

    for (const g of groups) {
      const groupKws = extractKeywords(g.theme);
      let overlap = 0;
      for (const kw of queryKws) {
        if (groupKws.has(kw)) overlap++;
      }
      const score = overlap / Math.max(queryKws.size, groupKws.size);
      if (score > bestOverlap && score >= 0.3) {
        bestOverlap = score;
        bestGroup = g;
      }
    }

    if (bestGroup) {
      bestGroup.queries.push(entry.query);
      for (const hit of entry.hits) {
        bestGroup.memoryIds.set(
          hit.id,
          (bestGroup.memoryIds.get(hit.id) ?? 0) + 1,
        );
      }
    } else {
      const group: QueryGroup = {
        theme: entry.query,
        queries: [entry.query],
        memoryIds: new Map(),
      };
      for (const hit of entry.hits) {
        group.memoryIds.set(hit.id, 1);
      }
      groups.push(group);
    }
  }

  return groups;
}

function groupsToThemes(groups: QueryGroup[], totalQueries: number): ThemeEntry[] {
  return groups
    .map((g) => {
      const sortedMemories = [...g.memoryIds.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);

      return {
        theme: g.theme,
        queryCount: g.queries.length,
        topMemories: sortedMemories,
        strength: totalQueries > 0 ? g.queries.length / totalQueries : 0,
      };
    })
    .filter((t) => t.queryCount >= 2) // at least 2 queries per theme
    .sort((a, b) => b.queryCount - a.queryCount);
}

// ── Emerging / Fading detection ────────────────────────

export function detectEmergingAndFading(
  currentThemes: ThemeEntry[],
  previousThemes: ThemeEntry[],
): { emerging: string[]; fading: string[] } {
  const currentSet = new Set(currentThemes.map((t) => t.theme.toLowerCase()));
  const previousSet = new Set(previousThemes.map((t) => t.theme.toLowerCase()));

  const emerging: string[] = [];
  for (const t of currentThemes) {
    if (!previousSet.has(t.theme.toLowerCase()) && t.queryCount >= 2) {
      emerging.push(t.theme);
    }
  }

  const fading: string[] = [];
  for (const t of previousThemes) {
    if (!currentSet.has(t.theme.toLowerCase()) && t.queryCount >= 2) {
      fading.push(t.theme);
    }
  }

  return { emerging, fading };
}

// ── LLM summary ───────────────────────────────────────

async function generateSummary(
  themes: ThemeEntry[],
  emerging: string[],
  fading: string[],
  llm: LlmHelper | null,
): Promise<string> {
  if (!llm || llm.exhausted || themes.length === 0) {
    // Fallback: generate a simple text summary
    const topThemes = themes
      .slice(0, 3)
      .map((t) => `${t.theme} (${t.queryCount}次)`)
      .join(", ");
    return `本週主要查詢主題：${topThemes}。`;
  }

  const themeList = themes
    .slice(0, 5)
    .map((t) => `- ${t.theme}: ${t.queryCount} queries, strength ${(t.strength * 100).toFixed(0)}%`)
    .join("\n");

  const prompt = [
    "Based on this week's memory recall patterns, write a brief 1-3 sentence reflection in the same language as the themes.",
    "Focus on what the user has been working on and any shifts in focus.",
    "",
    "Themes:",
    themeList,
    emerging.length > 0 ? `\nNewly emerging: ${emerging.join(", ")}` : "",
    fading.length > 0 ? `\nFading away: ${fading.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await llm.ask(prompt);
  return result ?? `本週主要查詢主題：${themes.slice(0, 3).map((t) => t.theme).join(", ")}。`;
}

// ── DREAMS.md write ────────────────────────────────────

const DREAMS_HEADER = "# DREAMS.md — Dream Diary\n\n> Auto-generated by autoDream REM phase. Do not edit the managed sections.\n";

export function formatReflectionSection(reflection: RemReflection): string {
  const { start, end } = (() => {
    // Parse week from period like "2026-W14"
    const match = reflection.period.match(/(\d{4})-W(\d{2})/);
    if (match) {
      const year = parseInt(match[1], 10);
      const week = parseInt(match[2], 10);
      // Approximate: week 1 starts around Jan 1
      const jan1 = new Date(Date.UTC(year, 0, 1));
      const dayOfWeek = jan1.getUTCDay() || 7;
      const mondayOfWeek1 = new Date(jan1);
      mondayOfWeek1.setUTCDate(jan1.getUTCDate() - dayOfWeek + 2);
      const monday = new Date(mondayOfWeek1);
      monday.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      return {
        start: monday.toISOString().slice(0, 10),
        end: sunday.toISOString().slice(0, 10),
      };
    }
    return { start: "?", end: "?" };
  })();

  const weekNum = reflection.period.match(/W(\d+)/)?.[1] ?? "?";

  const lines: string[] = [];
  lines.push(`## REM — Week ${weekNum} (${start} ~ ${end})`);
  lines.push("");

  if (reflection.themes.length > 0) {
    const themeStr = reflection.themes
      .map((t) => `${t.theme} (${t.queryCount}次)`)
      .join(", ");
    lines.push(`**主題：** ${themeStr}`);
    lines.push("");
  }

  if (reflection.emergingTopics.length > 0) {
    lines.push(`**新浮現：** ${reflection.emergingTopics.join(", ")}`);
  }
  if (reflection.fadingTopics.length > 0) {
    lines.push(`**逐漸消退：** ${reflection.fadingTopics.join(", ")}`);
  }
  if (reflection.emergingTopics.length > 0 || reflection.fadingTopics.length > 0) {
    lines.push("");
  }

  if (reflection.summary) {
    lines.push(`> ${reflection.summary.replace(/\n/g, "\n> ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeDreamsMd(
  filePath: string,
  reflection: RemReflection,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  let existing = "";
  try {
    existing = await fs.promises.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist
  }

  const section = formatReflectionSection(reflection);

  let content: string;
  if (!existing) {
    content = DREAMS_HEADER + "\n" + section;
  } else {
    // Check if this week's section already exists
    const weekHeader = `## REM — Week ${reflection.period.match(/W(\d+)/)?.[1]}`;
    if (existing.includes(weekHeader)) {
      // Replace existing section
      const idx = existing.indexOf(weekHeader);
      const nextSection = existing.indexOf("\n## ", idx + weekHeader.length);
      const before = existing.slice(0, idx).trimEnd();
      const after = nextSection >= 0 ? existing.slice(nextSection) : "";
      content = before + "\n\n" + section + after;
    } else {
      // Prepend after header (newest first)
      const headerEnd = existing.indexOf("\n\n", existing.indexOf(">"));
      if (headerEnd >= 0) {
        const before = existing.slice(0, headerEnd + 2);
        const after = existing.slice(headerEnd + 2);
        content = before + section + "\n" + after;
      } else {
        content = existing.trimEnd() + "\n\n" + section;
      }
    }
  }

  // Atomic write
  const tmpPath = filePath + `.tmp.${Date.now()}`;
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

// ── Main entry point ───────────────────────────────────

export async function runRemReflection(opts: {
  currentWeekEntries: RecallLogEntry[];
  previousWeekEntries?: RecallLogEntry[];
  llm: LlmHelper | null;
  config?: Partial<RemReflectionConfig>;
  workspacePath?: string;
  /** Override the "now" date for testing */
  now?: Date;
}): Promise<RemReflection | null> {
  const config = { ...DEFAULT_REM_CONFIG, ...opts.config };
  const now = opts.now ?? new Date();
  const workspacePath =
    opts.workspacePath ??
    path.join(os.homedir(), ".openclaw", "workspace");
  const dreamsMdPath = path.join(workspacePath, "DREAMS.md");

  // Gate: minimum recall count
  if (opts.currentWeekEntries.length < config.minWeeklyRecalls) {
    return null;
  }

  const period = getIsoWeek(now);

  // Cluster queries into themes
  const currentGroups = clusterQueriesByKeywords(opts.currentWeekEntries);
  const currentThemes = groupsToThemes(currentGroups, opts.currentWeekEntries.length);

  // Previous week themes (for emerging/fading)
  let previousThemes: ThemeEntry[] = [];
  if (opts.previousWeekEntries && opts.previousWeekEntries.length > 0) {
    const prevGroups = clusterQueriesByKeywords(opts.previousWeekEntries);
    previousThemes = groupsToThemes(prevGroups, opts.previousWeekEntries.length);
  }

  const { emerging, fading } = detectEmergingAndFading(currentThemes, previousThemes);

  // Generate summary
  const summary = await generateSummary(currentThemes, emerging, fading, opts.llm);

  const reflection: RemReflection = {
    period,
    themes: currentThemes,
    emergingTopics: emerging,
    fadingTopics: fading,
    summary,
  };

  // Write DREAMS.md
  await writeDreamsMd(dreamsMdPath, reflection);

  return reflection;
}

/** Check if today is Sunday (for scheduling gate) */
export function isSunday(date?: Date): boolean {
  return (date ?? new Date()).getDay() === 0;
}
