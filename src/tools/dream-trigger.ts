import { Type } from "@sinclair/typebox";
import { runDream } from "../dream-engine.js";
import { formatReportMarkdown } from "../report/reporter.js";
import type {
  OpenClawPluginToolContext,
  AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";

const parameters = Type.Object({
  scope: Type.Optional(
    Type.String({ description: "Memory scope to scan (omit for all)" }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "If true, only report without making changes (default: true)",
      default: true,
    }),
  ),
});

export function createDreamNowTool(
  pluginConfig: Record<string, unknown>,
  subagentRuntime?: unknown,
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (_ctx: OpenClawPluginToolContext) =>
    ({
      name: "dream_now",
      label: "Dream Now",
      description:
        "Scan memories for duplicates and generate a consolidation report. " +
        "Use dryRun=true (default) to preview changes without modifying anything.",
      parameters,
      execute: async (
        _toolCallId: string,
        params: { scope?: string; dryRun?: boolean },
      ) => {
        const dedupThreshold = Number(pluginConfig["dedupThreshold"] ?? 0.90);
        const maxChangesPerRun = Number(
          pluginConfig["maxChangesPerRun"] ?? 20,
        );
        const autoMergeDuplicates = Boolean(
          pluginConfig["autoMergeDuplicates"] ?? false,
        );
        const llmEnabled = pluginConfig["llmEnabled"] !== false;
        const llmModel = String(
          pluginConfig["llmModel"] ?? "anthropic:claude-3-5-haiku",
        );
        const llmMaxCalls = Number(pluginConfig["llmMaxCalls"] ?? 10);
        const llmProvider = pluginConfig["llmProvider"] as
          | "openai"
          | "anthropic"
          | undefined;
        const llmBaseUrl = pluginConfig["llmBaseUrl"] as string | undefined;
        const llmApiKey = pluginConfig["llmApiKey"] as string | undefined;

        const result = await runDream({
          scope: params.scope,
          dryRun: params.dryRun ?? true,
          dedupThreshold,
          maxChangesPerRun,
          autoMergeDuplicates,
          llmEnabled,
          llmModel,
          llmMaxCalls,
          llmProvider,
          llmBaseUrl,
          llmApiKey,
          subagentRuntime: subagentRuntime as any,
        });

        const markdown = formatReportMarkdown(result.report);
        const llmInfo = result.llmCallsUsed
          ? `\n\n*LLM calls used: ${result.llmCallsUsed}*`
          : "";
        const text = result.error
          ? `⚠️ Dream completed with warnings:\n${result.error}\n\n${markdown}${llmInfo}`
          : `${markdown}${llmInfo}`;

        return {
          content: [{ type: "text" as const, text }],
          details: result.report,
        };
      },
    }) as AnyAgentTool;
}
