import { Type } from "@sinclair/typebox";
import { getLastRunResult } from "../dream-engine.js";
import { LanceDbAdapter } from "../lancedb-adapter.js";
import type {
  OpenClawPluginToolContext,
  AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";

const parameters = Type.Object({});

export function createDreamStatusTool(): (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "dream_status",
      label: "Dream Status",
      description:
        "Show the status of the last autoDream run, including memory count and duplicate statistics.",
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
        lines.push(`## Modules`);
        lines.push(`- [x] dedup-detector`);
        lines.push(`- [x] time-normalizer`);
        lines.push(`- [x] conflict-detector`);
        lines.push(`- [x] staleness-scorer`);

        const text = lines.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { memoryCount, tables, lastRun: lastRun?.report ?? null },
        };
      },
    }) as AnyAgentTool;
}
