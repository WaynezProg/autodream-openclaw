import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { runDream } from "./dream-engine.js";
import type { SubagentRuntime } from "./analysis/llm-helper.js";
import { formatReportMarkdown, formatCompactReport, type DreamReport } from "./report/reporter.js";
import { writePersistedDreamStatus } from "./run-status.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface DreamServiceConfig {
  intervalHours: number;
  scheduleHour: number;
  minSessionsSinceLastRun: number;
  notifyTarget?: string;
  autoMergeDuplicates: boolean;
  autoFixTime: boolean;
  autoDeleteStale: boolean;
  staleAgeDays: number;
  dedupThreshold: number;
  maxChangesPerRun: number;
  scanLimit: number;
  /** Scopes allowed for background runs */
  allowedScopes: string[];

  // Deep Promotion
  deepEnabled: boolean;
  deepMinScore: number;
  deepMinRecallCount: number;
  deepMinUniqueQueries: number;
  deepMaxPromotionsPerRun: number;

  // REM Reflection
  remEnabled: boolean;
  remMinWeeklyRecalls: number;

  // Recall Tracker
  recallLogDir: string;
  recallMaxAgeDays: number;
}

const DEFAULT_CONFIG: DreamServiceConfig = {
  intervalHours: 24,
  scheduleHour: 3,
  minSessionsSinceLastRun: 3,
  autoMergeDuplicates: false,
  autoFixTime: false,
  autoDeleteStale: false,
  staleAgeDays: 60,
  dedupThreshold: 0.9,
  maxChangesPerRun: 20,
  scanLimit: 5000,
  allowedScopes: ["global"],

  // Deep Promotion
  deepEnabled: true,
  deepMinScore: 0.65,
  deepMinRecallCount: 3,
  deepMinUniqueQueries: 2,
  deepMaxPromotionsPerRun: 5,

  // REM Reflection
  remEnabled: true,
  remMinWeeklyRecalls: 10,

  // Recall Tracker
  recallLogDir: path.join(os.homedir(), ".openclaw", "memory", "autodream-reports"),
  recallMaxAgeDays: 90,
};

export interface DreamServiceInternals {
  computeNextRunTime(now: Date): Date;
  scheduleNextRun(): void;
  executeDream(): Promise<void>;
  getSessionCount(): number;
}

export function createDreamService(
  api: OpenClawPluginApi,
  embedder?: { embed(text: string): Promise<number[]> },
): OpenClawPluginService {
  const { service } = createDreamServiceWithInternals(api, embedder);
  return service;
}

export function createDreamServiceWithInternals(
  api: OpenClawPluginApi,
  embedder?: { embed(text: string): Promise<number[]> },
): { service: OpenClawPluginService; internals: DreamServiceInternals } {
  const config: DreamServiceConfig = { ...DEFAULT_CONFIG, ...api.pluginConfig };
  const logger = api.logger;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let sessionCount = 0;

  // Count agent_end events for the minimum-sessions gate
  api.on("agent_end", async () => {
    sessionCount++;
  });

  const internals: DreamServiceInternals = {
    computeNextRunTime,
    scheduleNextRun,
    executeDream,
    getSessionCount: () => sessionCount,
  };

  const service: OpenClawPluginService = {
    id: "autodream-scheduler",

    async start(_ctx: OpenClawPluginServiceContext) {
      logger.info?.("[autodream] Background service starting...");
      scheduleNextRun();
    },

    async stop(_ctx: OpenClawPluginServiceContext) {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      logger.info?.("[autodream] Background service stopped");
    },
  };

  return { service, internals };

  function computeNextRunTime(now: Date): Date {
    const target = new Date(now);
    target.setHours(config.scheduleHour, 0, 0, 0);

    // If the target time has already passed today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target;
  }

  function scheduleNextRun() {
    const now = new Date();
    const target = computeNextRunTime(now);
    const delayMs = target.getTime() - now.getTime();

    logger.debug?.(`[autodream] Next run scheduled at ${target.toISOString()}`);

    timerId = setTimeout(async () => {
      try {
        await executeDream();
      } catch (err) {
        logger.error?.(
          `[autodream] Dream run failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      scheduleNextRun();
    }, delayMs);
  }

  async function executeDream() {
    if (sessionCount < config.minSessionsSinceLastRun) {
      logger.debug?.(
        `[autodream] Skipping: only ${sessionCount} sessions since last run (need ${config.minSessionsSinceLastRun})`,
      );
      sessionCount = 0;
      return;
    }

    logger.info?.("[autodream] Starting scheduled dream run...");

    // runtime.subagent is not in the public SDK types but provided at runtime
    const subagentRuntime =
      ((api as unknown as { runtime?: { subagent?: SubagentRuntime } }).runtime?.subagent) ?? null;
    const pluginConfig = api.pluginConfig ?? {};

    // Parse allowedScopes from config (may be array or undefined)
    const allowedScopes = (pluginConfig["allowedScopes"] as string[] | undefined) ?? config.allowedScopes;

    // Parse LLM config
    const llmEnabled = pluginConfig["llmEnabled"] !== false;
    const llmModel = typeof pluginConfig["llmModel"] === "string"
      ? pluginConfig["llmModel"] : undefined;
    const llmMaxCalls = typeof pluginConfig["llmMaxCalls"] === "number"
      ? pluginConfig["llmMaxCalls"] : undefined;

    const result = await runDream({
      scopes: allowedScopes,
      dryRun:
        !config.autoMergeDuplicates &&
        !config.autoFixTime &&
        !config.autoDeleteStale,
      autoMergeDuplicates: config.autoMergeDuplicates,
      autoFixTime: config.autoFixTime,
      staleAgeDays: config.staleAgeDays,
      dedupThreshold: config.dedupThreshold,
      maxChangesPerRun: config.maxChangesPerRun,
      scanLimit: config.scanLimit,
      llmEnabled,
      llmModel,
      llmMaxCalls,
      llmProvider: pluginConfig["llmProvider"] as "openai" | "anthropic" | undefined,
      llmBaseUrl: pluginConfig["llmBaseUrl"] as string | undefined,
      llmApiKey: pluginConfig["llmApiKey"] as string | undefined,
      subagentRuntime,
      embedder,

      // Deep Promotion
      deepEnabled: config.deepEnabled,
      deepMinScore: config.deepMinScore,
      deepMinRecallCount: config.deepMinRecallCount,
      deepMinUniqueQueries: config.deepMinUniqueQueries,
      deepMaxPromotionsPerRun: config.deepMaxPromotionsPerRun,
      recallLogDir: config.recallLogDir,

      // REM Reflection
      remEnabled: config.remEnabled,
      remMinWeeklyRecalls: config.remMinWeeklyRecalls,
    });

    await writeReport(result.report);
    await writePersistedDreamStatus(result, "scheduled");

    // Notification & daily notes
    const compact = formatCompactReport(result.report);
    const summary = compact ?? `✅ autoDream 跑完了，掃描 ${result.report.scanned} 條記憶，沒有需要處理的變動。`;
    await writeDailyNotes(summary, allowedScopes);
    if (config.notifyTarget) {
      await sendNotification(config.notifyTarget, summary);
    }

    sessionCount = 0;

    logger.info?.(
      `[autodream] Dream complete: ${result.report.scanned} scanned, ` +
        `${result.report.duplicates.count} dup, ${result.report.conflicts.count} conflicts`,
    );
  }

  async function writeReport(report: DreamReport) {
    const reportDir = path.join(
      os.homedir(),
      ".openclaw",
      "memory",
      "autodream-reports",
    );
    await fs.promises.mkdir(reportDir, { recursive: true });

    const filename = `dream-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const filepath = path.join(reportDir, filename);

    const markdown = formatReportMarkdown(report);
    await fs.promises.writeFile(filepath, markdown, "utf-8");

    logger.debug?.(`[autodream] Report written to ${filepath}`);
  }

  async function writeDailyNotes(compact: string, scopes: string[]) {
    const today = new Date().toISOString().slice(0, 10);
    const timestamp = new Date().toISOString().slice(11, 16); // HH:MM

    for (const scope of scopes) {
      const notesDir = path.join(
        os.homedir(),
        ".openclaw",
        "workspace",
        "agents",
        scope,
        "memory",
      );
      const notesPath = path.join(notesDir, `${today}.md`);

      try {
        await fs.promises.mkdir(notesDir, { recursive: true });

        const entry = `\n## autoDream ${timestamp}\n\n${compact}\n`;
        await fs.promises.appendFile(notesPath, entry, "utf-8");

        logger.debug?.(`[autodream] Daily notes written to ${notesPath}`);
      } catch (err) {
        logger.warn?.(
          `[autodream] Failed to write daily notes for scope ${scope}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  async function sendNotification(target: string, message: string) {
    try {
      const runtime = (api as unknown as { runtime?: {
        system?: {
          runCommandWithTimeout: (
            cmd: string,
            args: string[],
            opts?: { timeoutMs?: number },
          ) => Promise<{ stdout: string; stderr: string }>;
        };
      } }).runtime;

      if (!runtime?.system?.runCommandWithTimeout) {
        logger.warn?.("[autodream] runtime.system.runCommandWithTimeout not available, skipping notification");
        return;
      }

      // Normalize target: bare Discord user IDs need user: prefix and --channel discord
      const isDiscordUserId = /^\d{17,20}$/.test(target);
      const normalizedTarget = isDiscordUserId ? `user:${target}` : target;
      const args = ["message", "send"];
      if (isDiscordUserId || target.startsWith("user:")) {
        args.push("--channel", "discord");
      }
      args.push("--target", normalizedTarget, "--message", message);

      await runtime.system.runCommandWithTimeout("openclaw", args, {
        timeoutMs: 15_000,
      });

      logger.debug?.(`[autodream] Notification sent to ${target}`);
    } catch (err) {
      logger.warn?.(
        `[autodream] Failed to send notification to ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// Exported for testing
export const _testing = {
  DEFAULT_CONFIG,
};
