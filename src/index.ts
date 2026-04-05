import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDreamNowTool } from "./tools/dream-trigger.js";
import { createDreamStatusTool } from "./tools/dream-status.js";
import { createDreamService } from "./dream-service.js";
import { registerDreamCli } from "./cli/dream-cli.js";

export default definePluginEntry({
  id: "autodream",
  name: "autoDream — Memory Consolidation",
  description:
    "自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間",

  register(api) {
    const pluginConfig = api.pluginConfig ?? {};

    // 註冊 dream_now tool (pass subagent runtime for LLM calls)
    const subagentRuntime = (api as any).runtime?.subagent ?? null;
    api.registerTool(createDreamNowTool(pluginConfig, subagentRuntime), {
      names: ["dream_now"],
    });

    // 註冊 dream_status tool
    api.registerTool(createDreamStatusTool(), {
      names: ["dream_status"],
    });

    // 註冊 agent_end hook（logging）
    const logger = api.logger;
    api.on("agent_end", async (event, ctx) => {
      logger.debug?.(
        `[autodream] agent_end: agentId=${ctx.agentId ?? "unknown"}, ` +
          `success=${event.success}, messages=${event.messages.length}`,
      );
    });

    // Task 3: 啟動背景排程服務
    api.registerService(createDreamService(api));

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
