import type { MemoryRecord } from "../lancedb-adapter.js";

export interface TimeFixEntry {
  memory: MemoryRecord;
  original: string;
  resolved: string;
  newText: string;
  confidence: "high" | "low";
}

interface PatternRule {
  regex: RegExp;
  confidence: "high" | "low";
  /** Return offset in days (negative = past). null means "no replacement, just flag". */
  offsetDays: (match: RegExpMatchArray) => number | null;
}

const PATTERNS: PatternRule[] = [
  // --- Chinese precise ---
  { regex: /前天/, confidence: "high", offsetDays: () => -2 },
  { regex: /昨天/, confidence: "high", offsetDays: () => -1 },
  { regex: /今天/, confidence: "high", offsetDays: () => 0 },
  {
    regex: /(\d+)\s*天前/,
    confidence: "high",
    offsetDays: (m) => -Number(m[1]),
  },
  {
    regex: /(\d+)\s*日前/,
    confidence: "high",
    offsetDays: (m) => -Number(m[1]),
  },
  { regex: /上週|上個星期/, confidence: "high", offsetDays: () => -7 },
  { regex: /上個月/, confidence: "high", offsetDays: () => -30 },
  {
    regex: /(\d+)\s*週前/,
    confidence: "high",
    offsetDays: (m) => -Number(m[1]) * 7,
  },
  {
    regex: /(\d+)\s*個月前/,
    confidence: "high",
    offsetDays: (m) => -Number(m[1]) * 30,
  },
  // --- English precise ---
  { regex: /\byesterday\b/i, confidence: "high", offsetDays: () => -1 },
  { regex: /\btoday\b/i, confidence: "high", offsetDays: () => 0 },
  {
    regex: /(\d+)\s*days?\s*ago/i,
    confidence: "high",
    offsetDays: (m) => -Number(m[1]),
  },
  { regex: /\blast\s+week\b/i, confidence: "high", offsetDays: () => -7 },
  { regex: /\blast\s+month\b/i, confidence: "high", offsetDays: () => -30 },
  { regex: /\bthis\s+week\b/i, confidence: "high", offsetDays: () => 0 },
  // --- Fuzzy ---
  { regex: /最近/, confidence: "low", offsetDays: () => null },
  { regex: /前陣子/, confidence: "low", offsetDays: () => null },
  { regex: /\brecently\b/i, confidence: "low", offsetDays: () => null },
  { regex: /\bearlier\b/i, confidence: "low", offsetDays: () => null },
];

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(epochMs: number, days: number): number {
  return epochMs + days * 86_400_000;
}

export function detectRelativeTime(memories: MemoryRecord[]): TimeFixEntry[] {
  const results: TimeFixEntry[] = [];

  for (const mem of memories) {
    for (const rule of PATTERNS) {
      const match = mem.text.match(rule.regex);
      if (!match) continue;

      const offset = rule.offsetDays(match);
      const original = match[0];

      if (rule.confidence === "low" || offset === null) {
        results.push({
          memory: mem,
          original,
          resolved: "",
          newText: mem.text,
          confidence: "low",
        });
      } else {
        const resolved = formatDate(addDays(mem.timestamp, offset));
        const newText = mem.text.replace(match[0], resolved);
        results.push({
          memory: mem,
          original,
          resolved,
          newText,
          confidence: "high",
        });
      }
      // Only match first pattern per memory
      break;
    }
  }

  return results;
}
