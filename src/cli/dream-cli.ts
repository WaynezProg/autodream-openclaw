import type { Command } from "commander";
import { runDream } from "../dream-engine.js";
import { formatReportMarkdown } from "../report/reporter.js";
import { runGovernance } from "../governance/governance-runner.js";

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
    .option("--apply-supersession", "Apply high-confidence supersession metadata changes", false)
    .option("--supersession-max <n>", "Maximum supersession changes to apply")
    .option("--governance", "Run deterministic governance pipeline", false)
    .option("--shadow", "Analyze and write manifests without semantic mutation", true)
    .option("--trigger <trigger>", "Governance trigger label", "manual")
    .action(async (options: {
      scope?: string;
      dryRun: boolean;
      applySupersession?: boolean;
      supersessionMax?: string;
      governance?: boolean;
      shadow?: boolean;
      trigger?: string;
    }) => {
      try {
        if (options.governance) {
          const governance = await runGovernance({
            shadow: options.shadow !== false,
            trigger: options.trigger ?? "manual",
            artifactDir:
              typeof pluginConfig.governanceArtifactDir === "string"
                ? pluginConfig.governanceArtifactDir
                : undefined,
            dreamOptions: {
              scope: options.scope,
              dedupThreshold: asNumber(pluginConfig.dedupThreshold),
              maxChangesPerRun: asNumber(pluginConfig.maxChangesPerRun),
              staleAgeDays: asNumber(pluginConfig.staleAgeDays),
              supersessionEnabled: asBool(pluginConfig.supersessionEnabled),
              supersessionApply: asBool(pluginConfig.supersessionApply),
              supersessionMaxChangesPerRun: asNumber(pluginConfig.supersessionMaxChangesPerRun),
              llmEnabled: asBool(pluginConfig.llmEnabled),
              llmModel: asString(pluginConfig.llmModel),
              llmMaxCalls: asNumber(pluginConfig.llmMaxCalls),
              llmProvider: asLlmProvider(pluginConfig.llmProvider),
              llmBaseUrl: asString(pluginConfig.llmBaseUrl),
              llmApiKey: asString(pluginConfig.llmApiKey),
            },
          });
          console.log(JSON.stringify(governance));
          if (governance.status !== "success") process.exitCode = 1;
          return;
        }
        if (!options.dryRun) {
          console.error(
            "[autodream] Direct mutation is disabled during the shadow rollout; use --governance --shadow.",
          );
          process.exitCode = 1;
          return;
        }
        const result = await runDream({
          scope: options.scope,
          dryRun: options.dryRun,
          dedupThreshold: asNumber(pluginConfig.dedupThreshold),
          maxChangesPerRun: asNumber(pluginConfig.maxChangesPerRun),
          autoMergeDuplicates: asBool(pluginConfig.autoMergeDuplicates),
          autoFixTime: asBool(pluginConfig.autoFixTime),
          staleAgeDays: asNumber(pluginConfig.staleAgeDays),
          supersessionEnabled: asBool(pluginConfig.supersessionEnabled),
          supersessionApply: Boolean(options.applySupersession),
          supersessionMaxChangesPerRun:
            asCliNumber(options.supersessionMax) ??
            asNumber(pluginConfig.supersessionMaxChangesPerRun),
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

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asLlmProvider(v: unknown): "openai" | "anthropic" | undefined {
  return v === "openai" || v === "anthropic" ? v : undefined;
}

function asCliNumber(v: string | undefined): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : undefined;
}
