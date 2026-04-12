import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { getLastRunResult } from "../dream-engine.js";
import { LanceDbAdapter } from "../lancedb-adapter.js";
import { readPersistedDreamStatus } from "../run-status.js";
import { RecallTracker } from "../tracking/recall-tracker.js";
import type {
  OpenClawPluginToolContext,
  AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";

const parameters = Type.Object({});

interface LastPromotionInfo {
  date: string;
  count: number;
  entries: string[];
  source: "status" | "workspace";
}

function parseLastPromotion(memoryMdPath: string): LastPromotionInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(memoryMdPath, "utf-8");
  } catch {
    return null;
  }

  const sectionHeader = "## Deep Promotion（auto-promoted）";
  const idx = content.indexOf(sectionHeader);
  if (idx < 0) return null;

  const section = content.slice(idx + sectionHeader.length);
  const memoryIds: string[] = [];
  let latestDate = "";

  const idRegex = /來源 memory ID: `([^`]+)`/g;
  const dateRegex = /\*\*\w+\*\*（(\d{4}-\d{2}-\d{2})）/g;

  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(section)) !== null) {
    memoryIds.push(match[1]);
  }
  while ((match = dateRegex.exec(section)) !== null) {
    if (match[1] > latestDate) latestDate = match[1];
  }

  if (memoryIds.length === 0) return null;

  return {
    date: latestDate || new Date().toISOString().slice(0, 10),
    count: memoryIds.length,
    entries: memoryIds,
    source: "workspace",
  };
}

interface LastReflectionInfo {
  period: string;
  themes: string[];
  source: "status" | "workspace";
}

function parseLastReflection(dreamsMdPath: string): LastReflectionInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(dreamsMdPath, "utf-8");
  } catch {
    return null;
  }

  const remMatch = content.match(/## REM — Week (\d+) \(([^)]+)\)/);
  if (!remMatch) return null;

  const weekNum = remMatch[1];
  const sectionStart = content.indexOf(remMatch[0]);
  const nextSection = content.indexOf("\n## ", sectionStart + remMatch[0].length);
  const section = nextSection >= 0
    ? content.slice(sectionStart, nextSection)
    : content.slice(sectionStart);

  const themeMatch = section.match(/\*\*主題：\*\*\s*(.+)/);
  const themes: string[] = [];
  if (themeMatch) {
    const parts = themeMatch[1].split(",").map((s) => s.trim());
    for (const p of parts) {
      const name = p.replace(/\s*\(\d+次\)\s*$/, "").trim();
      if (name) themes.push(name);
    }
  }

  const yearMatch = content.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
  const period = `${year}-W${weekNum.padStart(2, "0")}`;

  return { period, themes, source: "workspace" };
}

export function createDreamStatusTool(
  recallLogDir?: string,
  workspacePath?: string,
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "dream_status",
      label: "Dream Status",
      description:
        "Show the status of the last autoDream run, including memory count, recall tracker stats, promotion and reflection history.",
      parameters,
      execute: async (
        _toolCallId: string,
        _params: Record<string, never>,
      ) => {
        const sessionLastRun = getLastRunResult();
        const persisted = await readPersistedDreamStatus();

        const adapter = new LanceDbAdapter();
        let memoryCount = 0;
        let tables: string[] = [];
        let schemaColumns: string[] = [];

        try {
          await adapter.connect();
          tables = await adapter.listTableNames();
          memoryCount = await adapter.countMemories();
          try {
            schemaColumns = await adapter.getTableSchema();
          } catch {
          }
        } catch {
        } finally {
          await adapter.close();
        }

        const logDir =
          recallLogDir ??
          path.join(os.homedir(), ".openclaw", "memory", "autodream-reports");
        const tracker = new RecallTracker(logDir);
        const allEntries = await tracker.readLog();
        const stats = await tracker.getStats();
        const topRecalled = stats.slice(0, 5).map((s) => ({
          id: s.memoryId,
          count: s.totalRecalls,
        }));
        const oldestEntry = allEntries.length > 0
          ? new Date(Math.min(...allEntries.map((e) => e.ts))).toISOString()
          : "N/A";

        const wsPath =
          workspacePath ??
          path.join(os.homedir(), ".openclaw", "workspace");
        const workspacePromotion = parseLastPromotion(path.join(wsPath, "MEMORY.md"));
        const workspaceReflection = parseLastReflection(path.join(wsPath, "DREAMS.md"));

        const lastPromotion = persisted.lastDeepPromotion
          ? persisted.lastDeepPromotion
          : workspacePromotion;
        const lastReflection = persisted.lastRemReflection
          ? persisted.lastRemReflection
          : workspaceReflection;

        const currentRun = sessionLastRun?.report
          ? {
              timestamp: sessionLastRun.report.timestamp,
              scanned: sessionLastRun.report.scanned,
              duplicates: sessionLastRun.report.duplicates.count,
              dryRun: sessionLastRun.report.dryRun,
              warning: sessionLastRun.error,
              trigger: "manual" as const,
              promotions: sessionLastRun.report.promotions?.count ?? 0,
              reflection: Boolean(sessionLastRun.report.reflection),
            }
          : persisted.lastRun;

        const lines: string[] = [
          `# autoDream Status`,
          ``,
          `## Memory Database`,
          `- **Tables:** ${tables.length > 0 ? tables.join(", ") : "N/A"}`,
          `- **Total memories:** ${memoryCount}`,
          `- **Schema columns:** ${schemaColumns.length > 0 ? schemaColumns.join(", ") : "N/A"}`,
          ``,
          `## Last Run`,
        ];

        if (currentRun) {
          lines.push(`- **Time:** ${currentRun.timestamp}`);
          lines.push(`- **Trigger:** ${currentRun.trigger}`);
          lines.push(`- **Scanned:** ${currentRun.scanned}`);
          lines.push(`- **Duplicates found:** ${currentRun.duplicates}`);
          lines.push(`- **Dry-run:** ${currentRun.dryRun ? "Yes" : "No"}`);
          lines.push(`- **Deep Promotions:** ${currentRun.promotions}`);
          lines.push(`- **REM Reflection:** ${currentRun.reflection ? "Yes" : "No"}`);
          if (currentRun.warning) {
            lines.push(`- **Warning:** ${currentRun.warning}`);
          }
        } else {
          lines.push(`No previous run recorded.`);
        }

        lines.push(``);
        lines.push(`## Recall Tracker`);
        lines.push(`- **Total entries:** ${allEntries.length}`);
        lines.push(`- **Oldest entry:** ${oldestEntry}`);
        if (topRecalled.length > 0) {
          lines.push(`- **Top recalled memories:**`);
          for (const t of topRecalled) {
            lines.push(`  - \`${t.id}\`: ${t.count} times`);
          }
        } else {
          lines.push(`- **Top recalled memories:** (none)`);
        }

        lines.push(``);
        lines.push(`## Last Deep Promotion`);
        if (lastPromotion) {
          lines.push(`- **Date:** ${lastPromotion.date}`);
          lines.push(`- **Count:** ${lastPromotion.count}`);
          lines.push(`- **Source:** ${lastPromotion.source}`);
          lines.push(`- **Entries:** ${lastPromotion.entries.map((id) => `\`${id}\``).join(", ")}`);
        } else {
          lines.push(`No promotions recorded.`);
        }

        lines.push(``);
        lines.push(`## Last REM Reflection`);
        if (lastReflection) {
          lines.push(`- **Period:** ${lastReflection.period}`);
          lines.push(`- **Source:** ${lastReflection.source}`);
          lines.push(`- **Themes:** ${lastReflection.themes.join(", ") || "(none)"}`);
        } else {
          lines.push(`No reflections recorded.`);
        }

        lines.push(``);
        lines.push(`## Modules`);
        lines.push(`- [x] dedup-detector`);
        lines.push(`- [x] time-normalizer`);
        lines.push(`- [x] conflict-detector`);
        lines.push(`- [x] staleness-scorer`);
        lines.push(`- [x] recall-tracker`);
        lines.push(`- [x] deep-promoter`);
        lines.push(`- [x] rem-reflector`);

        const text = lines.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            memoryCount,
            tables,
            lastRun: currentRun,
            recallTracker: {
              totalEntries: allEntries.length,
              oldestEntry,
              topRecalledMemories: topRecalled,
            },
            lastPromotion,
            lastReflection,
            persistedStatusUpdatedAt: persisted.updatedAt || null,
          },
        };
      },
    }) as AnyAgentTool;
}
