# Design: autoRecall JSONL Bridge

## Architecture

```
plugins/memory-lancedb-pro/index.ts
  └── before_agent_start handler
      └── [NEW] retrieveWithRetry() 之後
          └── appendFile("auto-recall-log.jsonl", jsonLine)  ← 加 ~10 行

projects/autodream-openclaw/src/tracking/recall-tracker.ts
  └── readLog()
      └── [MOD] 同時讀取 recall-log.jsonl + auto-recall-log.jsonl ← 改 ~20 行

共用介面：JSONL 檔案格式（不是 npm package，不是 event）
```

## lancedb-pro 改動細節

```typescript
// --- 在 before_agent_start handler 裡，retrieveWithRetry() 之後 ---

// 現有程式碼（不改）：
const results = await retrieveWithRetry({ query: event.prompt, limit: 3, ... });
if (results.length > 0) {
  // prependContext 注入（既有邏輯不動）
}

// [NEW] 加在 prependContext 之後（fire-and-forget）：
if (results.length > 0) {
  const recallLogDir = pluginConfig.recallLogDir
    || join(homedir(), ".openclaw/memory/autodream-reports");
  const logLine = JSON.stringify({
    ts: Date.now(),
    query: event.prompt.slice(0, 500),
    agentId: ctx.agentId ?? "unknown",
    source: "auto-recall",
    hits: results.map(r => ({
      id: r.entry?.id,
      score: r.score ?? 0,
      scope: r.entry?.scope ?? "",
    })),
  }) + "\n";

  appendFile(join(recallLogDir, "auto-recall-log.jsonl"), logLine)
    .catch(err => api.logger.warn(`auto-recall log write failed: ${err.message}`));
}
```

**注意事項**：
- `appendFile` 是 `node:fs/promises` 的，lancedb-pro 已有 import
- fire-and-forget：`.catch()` 只 log warning，不阻塞
- `recallLogDir` 需要 `mkdir -p`：第一次寫入前確認目錄存在（可在 plugin init 時做一次）

## autodream 改動細節

```typescript
// --- RecallTracker.readLog() ---

// 既有：讀 recall-log.jsonl
const toolCallEntries = await this.parseJsonlFile(
  join(this.logDir, "recall-log.jsonl")
);

// [NEW] 同時讀 auto-recall-log.jsonl
const autoRecallEntries = await this.parseJsonlFile(
  join(this.logDir, "auto-recall-log.jsonl")
);

// 合併 + 排序
const allEntries = [...toolCallEntries, ...autoRecallEntries]
  .sort((a, b) => a.ts - b.ts);

return allEntries;
```

```typescript
// --- RecallTracker.prune() ---

// 既有 prune recall-log.jsonl 的邏輯
// [NEW] 對 auto-recall-log.jsonl 也做同樣的 prune
await this.pruneFile(join(this.logDir, "auto-recall-log.jsonl"), maxEntries, maxAge);
```

## 檔案結構

```
~/.openclaw/memory/autodream-reports/
├── recall-log.jsonl          # 既有：tool-call 的 recall 記錄
├── auto-recall-log.jsonl     # 新增：autoRecall 的 recall 記錄
├── dream-report-*.json       # 既有：dream 報告
└── ...
```

## Files to Modify

1. `plugins/memory-lancedb-pro/index.ts`
   - 在 `before_agent_start` handler 裡加 appendFile（~10 行）
   - init 時加 `mkdir` 確保目錄存在

2. `projects/autodream-openclaw/src/tracking/recall-tracker.ts`
   - `readLog()` 加讀第二個 JSONL 檔案
   - `prune()` 加 prune 第二個 JSONL 檔案

## Config

```jsonc
// openclaw.json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "config": {
          "recallLogDir": "~/.openclaw/memory/autodream-reports/"  // 可選，預設值即此
        }
      }
    }
  }
}
```

autodream 既有的 `recallLogDir` 預設值已經是同一個目錄，不需要額外 config。

## Testing

1. Restart gateway
2. 發一則訊息觸發 autoRecall
3. 檢查 `~/.openclaw/memory/autodream-reports/auto-recall-log.jsonl` 有新 entry
4. 確認 entry 有 `"source": "auto-recall"` 和正確的 hits
5. `dream_now(dryRun: true)` — recall stats 應包含 autoRecall 資料
6. 確認手動 `memory_recall` 仍寫入 `recall-log.jsonl`（不影響既有行為）
