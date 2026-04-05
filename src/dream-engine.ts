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
}

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
};

export interface DreamRunResult {
  report: DreamReport;
  merges?: MergeResult[];
  llmCallsUsed?: number;
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
        merges = await mergeWithLlm(dedupPairs, llm);
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
    );

    const result: DreamRunResult = {
      report,
      merges: merges.length > 0 ? merges : undefined,
      llmCallsUsed: llm?.used,
    };
    lastRunResult = result;
    return result;
  } finally {
    await adapter.close();
  }
}
