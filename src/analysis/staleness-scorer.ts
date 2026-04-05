import type { MemoryRecord } from "../lancedb-adapter.js";
import { parseMetadata } from "../lancedb-adapter.js";

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
  maxImportance?: number;
  scoreThreshold?: number;
}

const DEFAULTS: Required<StalenessOptions> = {
  staleAgeDays: 60,
  minAccessCount: 3,
  maxImportance: 0.3,
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

    const ageFactor = Math.min(ageDays / cfg.staleAgeDays, 1.0);
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
