import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { getLastRunResult } from "../dream-engine.js";
import { LanceDbAdapter } from "../lancedb-adapter.js";
import { RecallTracker } from "../tracking/recall-tracker.js";
import type {
  OpenClawPluginToolContext,
  AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";

const parameters = Type.Object({});

// ── Helpers for reading last promotion / reflection ────

interface LastPromotionInfo {
  date: string;
  count: number;
  entries: string[];
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

  // Extract memory IDs and dates from entries
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
  };
}

interface LastReflectionInfo {
  period: string;
  themes: string[];
}

function parseLastReflection(dreamsMdPath: string): LastReflectionInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(dreamsMdPath, "utf-8");
  } catch {
    return null;
  }

  // Find the first (most recent) REM section
  const remMatch = content.match(/## REM — Week (\d+) \(([^)]+)\)/);
  if (!remMatch) return null;

  const weekNum = remMatch[1];
  const sectionStart = content.indexOf(remMatch[0]);
  const nextSection = content.indexOf("\n## ", sectionStart + remMatch[0].length);
  const section = nextSection >= 0
    ? content.slice(sectionStart, nextSection)
    : content.slice(sectionStart);

  // Extract themes
  const themeMatch = section.match(/\*\*主題：\*\*\s*(.+)/);
  const themes: string[] = [];
  if (themeMatch) {
    // Parse "theme1 (N次), theme2 (N次)" format
    const parts = themeMatch[1].split(",").map((s) => s.trim());
    for (const p of parts) {
      const name = p.replace(/\s*\(\d+次\)\s*$/, "").trim();
      if (name) themes.push(name);
    }
  }

  // Determine period from week number and year
  const yearMatch = content.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
  const period = `${year}-W${weekNum.padStart(2, "0")}`;

  return { period, themes };
}

// ── Tool factory ───────────────────────────────────────

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
        const lastRun = getLastRunResult();

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
            // schema 讀取失敗不影響 status
          }
        } catch {
          // LanceDB 不可用
        } finally {
          await adapter.close();
        }

        // Recall Tracker stats
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

        // Last Promotion
        const wsPath =
          workspacePath ??
          path.join(os.homedir(), ".openclaw", "workspace");
        const lastPromotion = parseLastPromotion(path.join(wsPath, "MEMORY.md"));

        // Last Reflection
        const lastReflection = parseLastReflection(path.join(wsPath, "DREAMS.md"));

        // Build output
        const lines: string[] = [
          `# autoDream Status`,
          ``,
          `## Memory Database`,
          `- **Tables:** ${tables.length > 0 ? tables.join(", ") : "N/A"}`,
          `- **Total memories:** ${memoryCount}`,
          `- **Schema columns:** ${schemaColumns.length > 0 ? schemaColumns.join(", ") : "N/A"}`,
          ``,
        ];

        if (lastRun) {
          lines.push(`## Last Run`);
          lines.push(`- **Time:** ${lastRun.report.timestamp}`);
          lines.push(`- **Scanned:** ${lastRun.report.scanned}`);
          lines.push(
            `- **Duplicates found:** ${lastRun.report.duplicates.count}`,
          );
          lines.push(
            `- **Dry-run:** ${lastRun.report.dryRun ? "Yes" : "No"}`,
          );
          if (lastRun.error) {
            lines.push(`- **Warning:** ${lastRun.error}`);
          }
        } else {
          lines.push(`## Last Run`);
          lines.push(`No previous run recorded in this session.`);
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
          lines.push(`- **Entries:** ${lastPromotion.entries.map((id) => `\`${id}\``).join(", ")}`);
        } else {
          lines.push(`No promotions recorded.`);
        }

        lines.push(``);
        lines.push(`## Last REM Reflection`);
        if (lastReflection) {
          lines.push(`- **Period:** ${lastReflection.period}`);
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
            lastRun: lastRun?.report ?? null,
            recallTracker: {
              totalEntries: allEntries.length,
              oldestEntry,
              topRecalledMemories: topRecalled,
            },
            lastPromotion,
            lastReflection,
          },
        };
      },
    }) as AnyAgentTool;
}
