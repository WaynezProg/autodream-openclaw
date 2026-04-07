import type { MemoryRecord } from "../lancedb-adapter.js";
import { parseMetadata } from "../lancedb-adapter.js";

// ── Noise Pattern Matching ──────────────────────────────

export interface NoisePattern {
  /** Regex pattern to test against memory text */
  regex: string;
  /** Text must also contain this substring (AND condition) */
  requires?: string;
  /** Text must be shorter than this length to qualify as noise */
  maxLength?: number;
}

export const DEFAULT_NOISE_PATTERNS: NoisePattern[] = [
  { regex: "^Session:\\s*\\d{4}-\\d{2}-\\d{2}", requires: "Session Key:" },
  { regex: "^Session ID:\\s*[0-9a-f-]{36}" },
  { regex: "reflection-event · agent:", maxLength: 200 },
];

export function isNoiseMemory(text: string, patterns: NoisePattern[]): boolean {
  for (const p of patterns) {
    const re = new RegExp(p.regex);
    if (!re.test(text)) continue;
    if (p.requires && !text.includes(p.requires)) continue;
    if (p.maxLength !== undefined && text.length > p.maxLength) continue;
    return true;
  }
  return false;
}

/** Filter memories that match noise patterns. */
export function detectNoiseMemories(
  memories: MemoryRecord[],
  patterns?: NoisePattern[],
): MemoryRecord[] {
  const pats = patterns ?? DEFAULT_NOISE_PATTERNS;
  return memories.filter((m) => isNoiseMemory(m.text, pats));
}

export interface StaleEntry {
  memory: MemoryRecord;
  score: number;
  factors: {
    ageDays: number;
    accessCount: number;
    importance: number;
    tier: string | undefined;
  };
}

export interface StalenessOptions {
  staleAgeDays?: number;
  minAccessCount?: number;
  scoreThreshold?: number;
}

const DEFAULTS: Required<StalenessOptions> = {
  staleAgeDays: 60,
  minAccessCount: 3,
  scoreThreshold: 0.7,
};

export function scoreAndFilterStale(
  memories: MemoryRecord[],
  opts?: StalenessOptions,
): StaleEntry[] {
  const cfg = { ...DEFAULTS, ...opts };
  const now = Date.now();
  const results: StaleEntry[] = [];

  for (const m of memories) {
    const meta = parseMetadata(m.metadata);

    // Core tier: skip entirely
    if (meta.tier === "core") continue;

    const ageDays = (now - m.timestamp) / 86_400_000;
    const accessCount = meta.access_count ?? 0;

    const ageFactor = Math.max(0, Math.min(ageDays / cfg.staleAgeDays, 1.0));
    const accessFactor = Math.max(1 - accessCount / cfg.minAccessCount, 0);
    const importanceFactor = Math.max(1 - m.importance, 0);

    const score = ageFactor * 0.4 + accessFactor * 0.3 + importanceFactor * 0.3;

    if (score >= cfg.scoreThreshold) {
      results.push({
        memory: m,
        score,
        factors: {
          ageDays,
          accessCount,
          importance: m.importance,
          tier: meta.tier,
        },
      });
    }
  }

  // Sort descending by score
  results.sort((a, b) => b.score - a.score);
  return results;
}
