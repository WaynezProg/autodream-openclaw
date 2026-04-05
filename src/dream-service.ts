import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { runDream } from "./dream-engine.js";
import { formatReportMarkdown, type DreamReport } from "./report/reporter.js";
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
};

export function createDreamService(api: OpenClawPluginApi): OpenClawPluginService {
  const config: DreamServiceConfig = { ...DEFAULT_CONFIG, ...api.pluginConfig };
  const logger = api.logger;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let sessionCount = 0;
  let lastRunTime: number | null = null;

  // Count agent_end events for the minimum-sessions gate
  api.on("agent_end", async () => {
    sessionCount++;
  });

  return {
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
      await executeDream();
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

    const subagentRuntime = (api as any).runtime?.subagent ?? null;
    const pluginConfig = api.pluginConfig ?? {};
    const result = await runDream({
      dryRun:
        !config.autoMergeDuplicates &&
        !config.autoFixTime &&
        !config.autoDeleteStale,
      autoMergeDuplicates: config.autoMergeDuplicates,
      autoFixTime: config.autoFixTime,
      staleAgeDays: config.staleAgeDays,
      dedupThreshold: config.dedupThreshold,
      maxChangesPerRun: config.maxChangesPerRun,
      llmProvider: pluginConfig["llmProvider"] as "openai" | "anthropic" | undefined,
      llmBaseUrl: pluginConfig["llmBaseUrl"] as string | undefined,
      llmApiKey: pluginConfig["llmApiKey"] as string | undefined,
      subagentRuntime,
    });

    await writeReport(result.report);

    sessionCount = 0;
    lastRunTime = Date.now();

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
}

// Exported for testing
export const _testing = {
  DEFAULT_CONFIG,
};
