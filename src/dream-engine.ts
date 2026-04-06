import { LanceDbAdapter, type MemoryRecord } from "./lancedb-adapter.js";
import { detectDuplicates } from "./analysis/dedup-detector.js";
import { detectRelativeTime, resolveTimeWithLlm } from "./analysis/time-normalizer.js";
import {
  detectConflictsWithAmbiguous,
  confirmConflictsWithLlm,
} from "./analysis/conflict-detector.js";
import { scoreAndFilterStale } from "./analysis/staleness-scorer.js";
import { mergeWithLlm, type MergeResult } from "./analysis/dedup-merger.js";
import {
  LlmHelper,
  DEFAULT_LLM_CONFIG,
  type SubagentRuntime,
  type LlmProvider,
} from "./analysis/llm-helper.js";
import { buildReport, type DreamReport } from "./report/reporter.js";
import {
  runDeepPromotion,
  type DeepPromotionResult,
  type DeepPromotionConfig,
} from "./analysis/deep-promoter.js";
import {
  runRemReflection,
  isSunday,
  type RemReflection,
} from "./analysis/rem-reflector.js";
import { RecallTracker } from "./tracking/recall-tracker.js";

export interface DreamEngineConfig {
  dedupThreshold: number;
  maxChangesPerRun: number;
  autoMergeDuplicates: boolean;
  autoFixTime: boolean;
  staleAgeDays: number;
  /** Max memories to scan (default: 5000) */
  scanLimit: number;
  /** Enable LLM-assisted analysis (default: true) */
  llmEnabled: boolean;
  /** LLM model identifier (default: "gpt-4o") */
  llmModel: string;
  /** Max LLM calls per dream run (default: 10) */
  llmMaxCalls: number;
  /** LLM provider for direct HTTP calls: "openai" | "anthropic" */
  llmProvider?: LlmProvider;
  /** Base URL for OpenAI-compatible API (e.g. "http://localhost:11434/v1") */
  llmBaseUrl?: string;
  /** API key for cloud LLM providers */
  llmApiKey?: string;

  // Deep Promotion
  deepEnabled: boolean;
  deepMinScore: number;
  deepMinRecallCount: number;
  deepMinUniqueQueries: number;
  deepMaxPromotionsPerRun: number;
  deepRecencyHalfLifeDays: number;

  // REM Reflection
  remEnabled: boolean;
  remMinWeeklyRecalls: number;

  // Recall Tracker
  recallLogDir: string;
  recallMaxAgeDays: number;
}

import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CONFIG: DreamEngineConfig = {
  dedupThreshold: 0.90,
  maxChangesPerRun: 20,
  autoMergeDuplicates: false,
  autoFixTime: false,
  staleAgeDays: 60,
  scanLimit: 5000,
  llmEnabled: true,
  llmModel: DEFAULT_LLM_CONFIG.model,
  llmMaxCalls: DEFAULT_LLM_CONFIG.maxCalls,

  // Deep Promotion
  deepEnabled: true,
  deepMinScore: 0.65,
  deepMinRecallCount: 3,
  deepMinUniqueQueries: 2,
  deepMaxPromotionsPerRun: 5,
  deepRecencyHalfLifeDays: 14,

  // REM Reflection
  remEnabled: true,
  remMinWeeklyRecalls: 10,

  // Recall Tracker
  recallLogDir: path.join(os.homedir(), ".openclaw", "memory", "autodream-reports"),
  recallMaxAgeDays: 90,
};

export interface DreamRunResult {
  report: DreamReport;
  merges?: MergeResult[];
  llmCallsUsed?: number;
  promotions?: DeepPromotionResult;
  reflection?: RemReflection | null;
  error?: string;
}

let lastRunResult: DreamRunResult | null = null;

export function getLastRunResult(): DreamRunResult | null {
  return lastRunResult;
}

export async function runDream(
  opts?: Partial<DreamEngineConfig> & {
    /** Single scope to scan */
    scope?: string;
    /** Multiple scopes to scan (takes precedence over scope) */
    scopes?: string[];
    dryRun?: boolean;
    /** Pass the subagent runtime from plugin API for LLM calls */
    subagentRuntime?: SubagentRuntime | null;
    /** Skip Deep Promotion phase */
    skipDeep?: boolean;
    /** Skip REM Reflection phase */
    skipRem?: boolean;
    /** Force REM Reflection regardless of day */
    forceRem?: boolean;
    /** Workspace path for MEMORY.md / DREAMS.md */
    workspacePath?: string;
  },
): Promise<DreamRunResult> {
  const config = { ...DEFAULT_CONFIG, ...opts };
  const dryRun = opts?.dryRun ?? true; // Task 1: default dry-run

  // Resolve scopes to scan
  const scopesToScan: (string | undefined)[] =
    opts?.scopes && opts.scopes.length > 0
      ? opts.scopes
      : opts?.scope
        ? [opts.scope]
        : [undefined]; // undefined = all scopes

  // Set up LLM helper (null if disabled or no backend available)
  const hasBackend = opts?.subagentRuntime || config.llmProvider;
  const llm =
    config.llmEnabled && hasBackend
      ? new LlmHelper(opts?.subagentRuntime ?? null, {
          model: config.llmModel,
          maxCalls: config.llmMaxCalls,
          llmProvider: config.llmProvider,
          llmBaseUrl: config.llmBaseUrl,
          llmApiKey: config.llmApiKey,
        })
      : null;

  const adapter = new LanceDbAdapter({ scanLimit: config.scanLimit });

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

    // 讀取指定 scopes 的記憶
    let memories: MemoryRecord[] = [];
    for (const s of scopesToScan) {
      const scopeMemories = await adapter.listAllMemories(s);
      memories.push(...scopeMemories);
    }
    
    // Deduplicate by ID (in case same memory appears in multiple scope queries)
    const seenIds = new Set<string>();
    memories = memories.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });

    // Phase 2: Scan — rules-based first pass
    const dedupPairs = detectDuplicates(memories, {
      vectorThreshold: config.dedupThreshold,
    });
    const timeIssues = detectRelativeTime(memories);
    const { confirmed: ruleConflicts, ambiguous } =
      detectConflictsWithAmbiguous(memories);
    const staleItems = scoreAndFilterStale(memories, {
      staleAgeDays: config.staleAgeDays,
    });

    // Phase 2b: LLM refinement
    let merges: MergeResult[] = [];

    if (llm) {
      // Conflict: confirm ambiguous pairs via LLM
      const llmConflicts = await confirmConflictsWithLlm(ambiguous, llm);
      ruleConflicts.push(...llmConflicts);

      // Time: resolve low-confidence entries via LLM
      await resolveTimeWithLlm(timeIssues, llm);

      // Dedup: merge duplicates via LLM when autoMerge is on
      if (config.autoMergeDuplicates) {
        merges = await mergeWithLlm(
          dedupPairs.slice(0, config.maxChangesPerRun),
          llm,
        );
      }
    }

    // Phase 3: Apply time fixes (when autoFixTime is on and not dry-run)
    let timeFixesApplied = 0;
    if (config.autoFixTime && !dryRun) {
      const highConfidence = timeIssues.filter(
        (t) => t.confidence === "high" && t.resolved && t.newText !== t.memory.text,
      );
      const toApply = highConfidence.slice(0, config.maxChangesPerRun);
      for (const entry of toApply) {
        try {
          const ok = await adapter.updateMemoryText(entry.memory.id, entry.newText);
          if (ok) {
            timeFixesApplied++;
          } else {
            console.error(`[autodream] Failed to update ${entry.memory.id}`);
          }
        } catch (err) {
          console.error(`[autodream] Error updating ${entry.memory.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Phase 4: Deep Promotion
    let promotions: DeepPromotionResult | undefined;
    if (config.deepEnabled && !opts?.skipDeep && !dryRun) {
      try {
        const recallTracker = new RecallTracker(config.recallLogDir);
        const recallStats = await recallTracker.getStats({
          minRecalls: config.deepMinRecallCount,
        });

        if (recallStats.length > 0) {
          const deepConfig: Partial<DeepPromotionConfig> = {
            minScore: config.deepMinScore,
            minRecallCount: config.deepMinRecallCount,
            minUniqueQueries: config.deepMinUniqueQueries,
            maxPromotionsPerRun: config.deepMaxPromotionsPerRun,
            recencyHalfLifeDays: config.deepRecencyHalfLifeDays,
          };
          promotions = await runDeepPromotion({
            memories,
            recallStats,
            llm,
            config: deepConfig,
            workspacePath: opts?.workspacePath,
          });
        }
      } catch (err) {
        console.error(
          `[autodream] Deep Promotion error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Phase 5: REM Reflection (Sunday only, or forced)
    let reflection: RemReflection | null = null;
    const shouldRunRem =
      config.remEnabled &&
      !opts?.skipRem &&
      !dryRun &&
      (opts?.forceRem || isSunday());

    if (shouldRunRem) {
      try {
        const recallTracker = new RecallTracker(config.recallLogDir);
        const now = Date.now();
        const weekAgo = now - 7 * 86_400_000;
        const twoWeeksAgo = now - 14 * 86_400_000;

        const currentWeekEntries = await recallTracker.readLog(weekAgo);
        const allRecent = await recallTracker.readLog(twoWeeksAgo);
        const previousWeekEntries = allRecent.filter(
          (e) => e.ts >= twoWeeksAgo && e.ts < weekAgo,
        );

        reflection = await runRemReflection({
          currentWeekEntries,
          previousWeekEntries,
          llm,
          config: { minWeeklyRecalls: config.remMinWeeklyRecalls },
          workspacePath: opts?.workspacePath,
        });
      } catch (err) {
        console.error(
          `[autodream] REM Reflection error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 限制報告數量
    const limitedPairs = dedupPairs.slice(0, config.maxChangesPerRun);

    const report = buildReport(
      memories.length,
      limitedPairs,
      timeIssues,
      ruleConflicts,
      staleItems,
      dryRun,
      config.autoMergeDuplicates,
      merges.length > 0 ? merges : undefined,
      llm?.used,
      timeFixesApplied,
      promotions,
      reflection,
    );

    const result: DreamRunResult = {
      report,
      merges: merges.length > 0 ? merges : undefined,
      llmCallsUsed: llm?.used,
      promotions,
      reflection,
    };
    lastRunResult = result;
    return result;
  } finally {
    await adapter.close();
  }
}
