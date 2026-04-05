import type { Command } from "commander";
import { runDream } from "../dream-engine.js";
import { formatReportMarkdown } from "../report/reporter.js";

/** Matches the shape of OpenClawPluginCliContext (not re-exported from plugin-entry). */
interface CliContext {
  program: Command;
}

export function registerDreamCli(
  ctx: CliContext,
  pluginConfig: Record<string, unknown>,
): void {
  ctx.program
    .command("dream")
    .description("Run memory consolidation (autoDream)")
    .option("--scope <scope>", "Limit to specific scope")
    .option("--dry-run", "Run in dry-run mode (no changes)", true)
    .option("--no-dry-run", "Apply changes (merge duplicates, fix time)")
    .action(async (options: { scope?: string; dryRun: boolean }) => {
      try {
        const result = await runDream({
          scope: options.scope,
          dryRun: options.dryRun,
          dedupThreshold: asNumber(pluginConfig.dedupThreshold),
          maxChangesPerRun: asNumber(pluginConfig.maxChangesPerRun),
          autoMergeDuplicates: asBool(pluginConfig.autoMergeDuplicates),
          autoFixTime: asBool(pluginConfig.autoFixTime),
          staleAgeDays: asNumber(pluginConfig.staleAgeDays),
        });

        if (result.error) {
          console.error(`[autodream] Warning: ${result.error}`);
        }

        const markdown = formatReportMarkdown(result.report);
        console.log(markdown);
      } catch (err) {
        console.error(
          `[autodream] Error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
