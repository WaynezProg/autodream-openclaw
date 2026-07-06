import * as os from "node:os";
import * as path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDreamNowTool } from "./tools/dream-trigger.js";
import { createDreamStatusTool } from "./tools/dream-status.js";
import { createDreamService } from "./dream-service.js";
import { registerDreamCli } from "./cli/dream-cli.js";
import { RecallTracker } from "./tracking/recall-tracker.js";

export default definePluginEntry({
  id: "autodream",
  name: "autoDream — Memory Consolidation",
  description:
    "自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間",

  register(api) {
    const pluginConfig = api.pluginConfig ?? {};

    // Phase 1: Recall Tracker
    const recallLogDir =
      (pluginConfig as Record<string, unknown>).recallLogDir as string | undefined ??
      path.join(os.homedir(), ".openclaw", "memory", "autodream-reports");
    const recallTracker = new RecallTracker(recallLogDir);

    // 註冊 dream_now tool (pass subagent runtime for LLM calls)
    // runtime.subagent is not in the public SDK types but provided at runtime
    const subagentRuntime =
      (api as unknown as { runtime?: { subagent?: unknown } }).runtime?.subagent ?? null;

    // Initialize embedder for re-embedding after merge
    // API key comes from plugin config (llmApiKey) — never from env vars
    const embeddingModel =
      (pluginConfig as Record<string, unknown>).embeddingModel as string | undefined ??
      "text-embedding-3-small";
    const embedderKey =
      (pluginConfig as Record<string, unknown>).llmApiKey as string | undefined;
    const embedder = embedderKey
      ? {
          async embed(text: string): Promise<number[]> {
            const res = await fetch("https://api.openai.com/v1/embeddings", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${embedderKey}`,
              },
              body: JSON.stringify({ model: embeddingModel, input: text }),
            });
            if (!res.ok) {
              throw new Error(`Embedding API error: ${res.status} ${res.statusText}`);
            }
            const json = (await res.json()) as {
              data: Array<{ embedding: number[] }>;
            };
            return json.data[0].embedding;
          },
        }
      : undefined;

    api.registerTool(createDreamNowTool(pluginConfig, subagentRuntime, embedder), {
      names: ["dream_now"],
    });

    // 註冊 dream_status tool
    api.registerTool(createDreamStatusTool(recallLogDir), {
      names: ["dream_status"],
    });

    // 註冊 agent_end hook（logging + recall tracking）
    const logger = api.logger;

    // 使用 after_tool_call hook 追蹤 memory_recall（2026.4.10 正式 hook 名稱）
    api.on("after_tool_call", async (event: any, ctx: any) => {
      if (event.toolName !== "memory_recall") return;
      const entry = recallTracker.recordFromToolResult(
        event,
        event.args?.query ?? "",
        ctx?.agentId,
      );
      if (entry) {
        await recallTracker.record(entry);
        logger.debug?.(`[autodream] recall tracked: ${entry.hits.length} hits`);
      }
    });

    // agent_end hook（logging + recall tracking fallback）
    api.on("agent_end", async (event, ctx) => {
      logger.debug?.(
        `[autodream] agent_end: agentId=${ctx.agentId ?? "unknown"}, ` +
          `success=${event.success}, messages=${event.messages.length}`,
      );

      // Fallback: extract memory_recall from messages
      for (const msg of event.messages) {
        const m = msg as { role?: string; toolName?: string; content?: unknown };
        if (m.role === "tool" && m.toolName === "memory_recall") {
          const entry = recallTracker.recordFromMessage(m, ctx.agentId);
          if (entry) {
            await recallTracker.record(entry);
            logger.debug?.(`[autodream] recall tracked (fallback): ${entry.hits.length} hits`);
          }
        }
      }
    });

    // Task 3: 啟動背景排程服務
    api.registerService(createDreamService(api, embedder));

    // Task 4: 註冊 CLI 命令
    api.registerCli(
      (ctx) => registerDreamCli(ctx, pluginConfig),
      {
        descriptors: [
          { name: "dream", description: "Run memory consolidation", hasSubcommands: false },
        ],
      },
    );
  },
});
