# Task 3: Background Service + 排程

## 背景

Task 1-2 已完成：
- Plugin 骨架 + dream_now/dream_status tools
- 四個 analysis 模組（dedup/time/conflict/stale）
- 報告生成器

Task 3 要實作背景服務，定時自動執行 dream。

## 現有 Code 結構

```
src/
├── index.ts                    ← Plugin entry（已有 registerTool, api.on("agent_end")）
├── dream-engine.ts             ← runDream(), getLastRunResult()
├── lancedb-adapter.ts
├── analysis/
│   ├── dedup-detector.ts
│   ├── time-normalizer.ts
│   ├── conflict-detector.ts
│   └── staleness-scorer.ts
├── tools/
│   ├── dream-trigger.ts        ← dream_now tool
│   └── dream-status.ts         ← dream_status tool
└── report/
    └── reporter.ts             ← buildReport(), formatReportMarkdown()
```

## 要做的事

### 1. dream-service.ts (`src/dream-service.ts`)

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runDream } from "./dream-engine.js";
import { formatReportMarkdown, type DreamReport } from "./report/reporter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface DreamServiceConfig {
  intervalHours: number;           // 預設 24
  scheduleHour: number;            // 預設 3（凌晨 3 點 GMT+8）
  minSessionsSinceLastRun: number; // 預設 3
  notifyTarget?: string;           // Discord channel ID（可選）
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
  dedupThreshold: 0.90,
  maxChangesPerRun: 20,
};
```

### 2. Service 實作

```typescript
export function createDreamService(api: OpenClawPluginApi) {
  const config = { ...DEFAULT_CONFIG, ...api.pluginConfig } as DreamServiceConfig;
  const logger = api.logger;
  
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let sessionCount = 0;
  let lastRunTime: number | null = null;
  
  // 註冊 agent_end 計數器
  api.on("agent_end", async () => {
    sessionCount++;
  });
  
  return {
    id: "autodream-scheduler",
    
    async start() {
      logger.info?.("[autodream] Background service starting...");
      scheduleNextRun();
    },
    
    async stop() {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      logger.info?.("[autodream] Background service stopped");
    },
  };
  
  function scheduleNextRun() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(config.scheduleHour, 0, 0, 0);
    
    // 如果目標時間已過，排到明天
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    
    const delayMs = target.getTime() - now.getTime();
    
    logger.debug?.(`[autodream] Next run scheduled at ${target.toISOString()}`);
    
    timerId = setTimeout(async () => {
      await executeDream();
      scheduleNextRun();
    }, delayMs);
  }
  
  async function executeDream() {
    if (sessionCount < config.minSessionsSinceLastRun) {
      logger.debug?.(`[autodream] Skipping: only ${sessionCount} sessions since last run`);
      sessionCount = 0;
      return;
    }
    
    logger.info?.("[autodream] Starting scheduled dream run...");
    
    const result = await runDream({
      dryRun: !config.autoMergeDuplicates && !config.autoFixTime && !config.autoDeleteStale,
      autoMergeDuplicates: config.autoMergeDuplicates,
      autoFixTime: config.autoFixTime,
      staleAgeDays: config.staleAgeDays,
      dedupThreshold: config.dedupThreshold,
      maxChangesPerRun: config.maxChangesPerRun,
    });
    
    await writeReport(result.report);
    
    sessionCount = 0;
    lastRunTime = Date.now();
    
    logger.info?.(`[autodream] Dream complete: ${result.report.scanned} scanned, ${result.report.duplicates.count} dup, ${result.report.conflicts.count} conflicts`);
  }
  
  async function writeReport(report: DreamReport) {
    const reportDir = path.join(os.homedir(), ".openclaw", "memory", "autodream-reports");
    await fs.promises.mkdir(reportDir, { recursive: true });
    
    const filename = `dream-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const filepath = path.join(reportDir, filename);
    
    const markdown = formatReportMarkdown(report);
    await fs.promises.writeFile(filepath, markdown, "utf-8");
    
    logger.debug?.(`[autodream] Report written to ${filepath}`);
  }
}
```

### 3. 更新 index.ts

```typescript
import { createDreamService } from "./dream-service.js";

export default definePluginEntry({
  // ...
  register(api) {
    // ... existing code ...
    
    // Task 3: 啟動背景服務
    api.registerService(createDreamService(api));
  },
});
```

## 排程邏輯

1. **scheduleHour** — 目標執行時間（預設凌晨 3 點）
2. **intervalHours** — 最小間隔（預設 24 小時，但實際由 scheduleHour 決定每日一次）
3. **minSessionsSinceLastRun** — 自上次執行後至少要有 N 個 session 才會觸發（避免無 activity 時空跑）

計算方式：
- 計算下一個 scheduleHour 時間點
- 如果該時間點已過，排到隔天
- setTimeout 到該時間點執行

## 報告存放位置

```
~/.openclaw/memory/autodream-reports/
├── dream-2026-04-05T03-00-00-000Z.md
├── dream-2026-04-06T03-00-00-000Z.md
└── ...
```

## 驗收標準

| 項目 | 標準 |
|------|------|
| `npx tsc` | 零 error |
| `npx vitest run` | 所有測試通過 |
| dream-service.ts | 存在且 export createDreamService |
| index.ts | 有 `api.registerService(createDreamService(api))` |
| openclaw.plugin.json | config schema 包含所有新選項 |
| 排程邏輯 | setTimeout + scheduleHour 計算正確 |
| 報告寫入 | 執行後 report 檔案出現在 ~/.openclaw/memory/autodream-reports/ |
| 服務啟停 | start() 排程，stop() 清除 timer |

## 測試

建立 `tests/dream-service.test.ts`：

1. scheduleNextRun() 計算的下次執行時間正確
2. session 閾值檢查（< minSessions 不執行）
3. writeReport() 寫入檔案成功
4. stop() 清除 timer

## 注意事項

- 所有 import 使用 `.js` 後綴（ESM 規則）
- `api.registerService()` 的 service 物件要有 `id`, `start()`, `stop()`
- `api.on("agent_end")` 可以多次註冊（index.ts 已有一個用於 logging，dream-service 再註冊一個用於計數）
- logger 用 `logger.info?.()` / `logger.debug?.()`（optional chaining，因為 logger 可能沒有這些方法）
- **不要改** dream-engine.ts 的 function signature
- **不要改** tool name 和 tool signature（`dream_now`、`dream_status`）
- notifyTarget 功能是 optional，SDK 不支援就跳過
