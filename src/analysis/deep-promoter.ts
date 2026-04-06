import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryRecord } from "../lancedb-adapter.js";
import type { RecallStats } from "../tracking/recall-tracker.js";
import type { LlmHelper } from "./llm-helper.js";
import { extractKeywords } from "./dedup-detector.js";

// ── Types ──────────────────────────────────────────────

export interface DeepPromotionConfig {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  maxPromotionsPerRun: number;
  recencyHalfLifeDays: number;
  maxAgeDays: number;
}

export const DEFAULT_DEEP_CONFIG: DeepPromotionConfig = {
  minScore: 0.65,
  minRecallCount: 3,
  minUniqueQueries: 2,
  maxPromotionsPerRun: 5,
  recencyHalfLifeDays: 14,
  maxAgeDays: 30,
};

export interface DeepSignals {
  frequency: number;
  relevance: number;
  queryDiversity: number;
  recency: number;
  consolidation: number;
  richness: number;
}

export interface DeepCandidate {
  memory: MemoryRecord;
  recallStats: RecallStats;
  signals: DeepSignals;
  score: number;
}

export interface DeepPromotionEntry {
  memoryId: string;
  score: number;
  refinedText: string;
  category: string;
  date: string;
}

export interface DeepPromotionResult {
  count: number;
  entries: DeepPromotionEntry[];
}

// ── Signal weights ─────────────────────────────────────

const WEIGHTS = {
  frequency: 0.24,
  relevance: 0.30,
  queryDiversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  richness: 0.06,
} as const;

// ── Scoring ────────────────────────────────────────────

export function computeSignals(
  memory: MemoryRecord,
  stats: RecallStats,
  config: DeepPromotionConfig,
): DeepSignals {
  const now = Date.now();
  const daysSinceLastRecall = (now - stats.lastRecalledAt) / 86_400_000;

  const frequency = Math.min(stats.totalRecalls / 10, 1);
  const relevance = stats.avgScore;
  const queryDiversity = Math.min(stats.uniqueQueries / 5, 1);
  const recency = Math.exp(
    (-Math.LN2 * daysSinceLastRecall) / config.recencyHalfLifeDays,
  );
  const consolidation = Math.min(stats.daySpan / 7, 1);

  const keywords = extractKeywords(memory.text);
  const richness = Math.min(keywords.size / 15, 1);

  return { frequency, relevance, queryDiversity, recency, consolidation, richness };
}

export function computeScore(signals: DeepSignals): number {
  return (
    signals.frequency * WEIGHTS.frequency +
    signals.relevance * WEIGHTS.relevance +
    signals.queryDiversity * WEIGHTS.queryDiversity +
    signals.recency * WEIGHTS.recency +
    signals.consolidation * WEIGHTS.consolidation +
    signals.richness * WEIGHTS.richness
  );
}

// ── Candidate selection ────────────────────────────────

export function selectCandidates(
  memories: MemoryRecord[],
  statsMap: Map<string, RecallStats>,
  config: DeepPromotionConfig = DEFAULT_DEEP_CONFIG,
): DeepCandidate[] {
  const now = Date.now();
  const maxAgeMs = config.maxAgeDays * 86_400_000;
  const candidates: DeepCandidate[] = [];

  for (const memory of memories) {
    const stats = statsMap.get(memory.id);
    if (!stats) continue;

    // Gate: min recall count
    if (stats.totalRecalls < config.minRecallCount) continue;

    // Gate: min unique queries
    if (stats.uniqueQueries < config.minUniqueQueries) continue;

    // Gate: max age since last recall
    if (now - stats.lastRecalledAt > maxAgeMs) continue;

    const signals = computeSignals(memory, stats, config);
    const score = computeScore(signals);

    // Gate: min score
    if (score < config.minScore) continue;

    candidates.push({ memory, recallStats: stats, signals, score });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Limit
  return candidates.slice(0, config.maxPromotionsPerRun);
}

// ── Dedup against existing MEMORY.md ───────────────────

export function isAlreadyPromoted(
  memoryText: string,
  existingContent: string,
): boolean {
  if (!existingContent) return false;

  // Normalize for comparison
  const normalize = (s: string) =>
    s.toLowerCase().replace(/\s+/g, " ").trim();

  const normalized = normalize(memoryText);
  const existing = normalize(existingContent);

  // Direct substring match (either direction)
  if (existing.includes(normalized) || normalized.includes(existing)) {
    return true;
  }

  // Word-level overlap check (Jaccard > 0.7 = likely duplicate)
  const wordsA = new Set(normalized.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(existing.split(" ").filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  const jaccard = intersection / union;

  return jaccard > 0.7;
}

// ── LLM refinement ─────────────────────────────────────

async function refineWithLlm(
  memory: MemoryRecord,
  llm: LlmHelper | null,
): Promise<string> {
  if (!llm || llm.exhausted) return memory.text;

  const prompt = [
    "Refine this memory into a concise, self-contained knowledge entry for MEMORY.md.",
    "Keep key facts, dates, and decisions. Remove session-specific noise.",
    "Output the refined text only, in the same language as the input.",
    "",
    `Memory: ${memory.text}`,
    `Category: ${memory.category}`,
    `Scope: ${memory.scope}`,
  ].join("\n");

  const result = await llm.ask(prompt);
  return result ?? memory.text;
}

// ── MEMORY.md write ────────────────────────────────────

const SECTION_HEADER = "## Deep Promotion（auto-promoted）";

export function appendPromotionSection(
  existingContent: string,
  entries: DeepPromotionEntry[],
): string {
  if (entries.length === 0) return existingContent;

  const newLines = entries.map(
    (e) =>
      `- **${e.category}**（${e.date}）：${e.refinedText}\n` +
      `  - 來源 memory ID: \`${e.memoryId}\`\n` +
      `  - 升級分數: ${e.score.toFixed(4)}`,
  );

  const sectionIdx = existingContent.indexOf(SECTION_HEADER);
  if (sectionIdx >= 0) {
    // Find end of section (next ## or end of file)
    const afterHeader = sectionIdx + SECTION_HEADER.length;
    const nextSection = existingContent.indexOf("\n## ", afterHeader);
    const insertAt = nextSection >= 0 ? nextSection : existingContent.length;

    // Insert before next section (or at end)
    const before = existingContent.slice(0, insertAt).trimEnd();
    const after = existingContent.slice(insertAt);
    return before + "\n\n" + newLines.join("\n\n") + after;
  }

  // Section doesn't exist — create it
  const trimmed = existingContent.trimEnd();
  return trimmed + "\n\n" + SECTION_HEADER + "\n\n" + newLines.join("\n\n") + "\n";
}

export async function writeMemoryMdAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  // Atomic write: write to tmp, then rename
  const tmpPath = filePath + `.tmp.${Date.now()}`;
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

// ── Main entry point ───────────────────────────────────

export async function runDeepPromotion(opts: {
  memories: MemoryRecord[];
  recallStats: RecallStats[];
  llm: LlmHelper | null;
  config?: Partial<DeepPromotionConfig>;
  workspacePath?: string;
}): Promise<DeepPromotionResult> {
  const config = { ...DEFAULT_DEEP_CONFIG, ...opts.config };
  const workspacePath =
    opts.workspacePath ??
    path.join(os.homedir(), ".openclaw", "workspace");
  const memoryMdPath = path.join(workspacePath, "MEMORY.md");

  // Build stats map
  const statsMap = new Map<string, RecallStats>();
  for (const s of opts.recallStats) {
    statsMap.set(s.memoryId, s);
  }

  // Select candidates
  const candidates = selectCandidates(opts.memories, statsMap, config);
  if (candidates.length === 0) {
    return { count: 0, entries: [] };
  }

  // Read existing MEMORY.md
  let existingContent = "";
  try {
    existingContent = await fs.promises.readFile(memoryMdPath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  // Filter out already-promoted
  const novel = candidates.filter(
    (c) => !isAlreadyPromoted(c.memory.text, existingContent),
  );

  if (novel.length === 0) {
    return { count: 0, entries: [] };
  }

  // Refine with LLM and build entries
  const entries: DeepPromotionEntry[] = [];
  for (const c of novel) {
    const refinedText = await refineWithLlm(c.memory, opts.llm);
    entries.push({
      memoryId: c.memory.id,
      score: c.score,
      refinedText,
      category: c.memory.category,
      date: new Date().toISOString().slice(0, 10),
    });
  }

  // Write to MEMORY.md (atomic)
  const updatedContent = appendPromotionSection(existingContent, entries);
  await writeMemoryMdAtomic(memoryMdPath, updatedContent);

  return { count: entries.length, entries };
}
