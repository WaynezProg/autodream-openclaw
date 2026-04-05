import { LanceDbAdapter } from "./lancedb-adapter.js";
import { detectDuplicates } from "./analysis/dedup-detector.js";
import { detectRelativeTime } from "./analysis/time-normalizer.js";
import { detectConflicts } from "./analysis/conflict-detector.js";
import { scoreAndFilterStale } from "./analysis/staleness-scorer.js";
import { buildReport, type DreamReport } from "./report/reporter.js";

export interface DreamEngineConfig {
  dedupThreshold: number;
  maxChangesPerRun: number;
  autoMergeDuplicates: boolean;
  autoFixTime: boolean;
  staleAgeDays: number;
}

const DEFAULT_CONFIG: DreamEngineConfig = {
  dedupThreshold: 0.90,
  maxChangesPerRun: 20,
  autoMergeDuplicates: false,
  autoFixTime: false,
  staleAgeDays: 60,
};

export interface DreamRunResult {
  report: DreamReport;
  error?: string;
}

let lastRunResult: DreamRunResult | null = null;

export function getLastRunResult(): DreamRunResult | null {
  return lastRunResult;
}

export async function runDream(
  opts?: Partial<DreamEngineConfig> & { scope?: string; dryRun?: boolean },
): Promise<DreamRunResult> {
  const config = { ...DEFAULT_CONFIG, ...opts };
  const dryRun = opts?.dryRun ?? true; // Task 1: default dry-run

  const adapter = new LanceDbAdapter();

  try {
    await adapter.connect();

    // 驗證 schema
    let columns: string[];
    try {
      columns = await adapter.getTableSchema();
    } catch (err) {
      const result: DreamRunResult = {
        report: buildReport(0, [], [], [], [], dryRun, config.autoMergeDuplicates),
        error: `Schema detection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      lastRunResult = result;
      return result;
    }

    // 確認有 vector column
    const hasVector = columns.includes("vector") || columns.includes("embedding");
    if (!hasVector) {
      const result: DreamRunResult = {
        report: buildReport(0, [], [], [], [], dryRun, config.autoMergeDuplicates),
        error: `No vector/embedding column found. Columns: ${columns.join(", ")}`,
      };
      lastRunResult = result;
      return result;
    }

    // 讀取所有記憶
    const memories = await adapter.listAllMemories(opts?.scope);

    // Phase 2: Scan
    const dedupPairs = detectDuplicates(memories, {
      vectorThreshold: config.dedupThreshold,
    });
    const timeIssues = detectRelativeTime(memories);
    const conflicts = detectConflicts(memories);
    const staleItems = scoreAndFilterStale(memories, {
      staleAgeDays: config.staleAgeDays,
    });

    // 限制報告數量
    const limitedPairs = dedupPairs.slice(0, config.maxChangesPerRun);

    const report = buildReport(
      memories.length,
      limitedPairs,
      timeIssues,
      conflicts,
      staleItems,
      dryRun,
      config.autoMergeDuplicates,
    );

    const result: DreamRunResult = { report };
    lastRunResult = result;
    return result;
  } finally {
    await adapter.close();
  }
}
