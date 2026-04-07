# Spec: autoRecall JSONL Bridge

## Requirement: lancedb-pro Writes autoRecall Log

lancedb-pro 的 `before_agent_start` handler 在 autoRecall 成功後，SHALL 將 recall event 寫入 JSONL 檔。

### JSONL Entry Format

```jsonc
{
  "ts": 1712500000000,        // Date.now()
  "query": "用戶的 prompt",    // 截斷至 500 chars
  "agentId": "main",
  "source": "auto-recall",
  "hits": [
    { "id": "uuid-xxx", "score": 0.85, "scope": "agent:main" },
    { "id": "uuid-yyy", "score": 0.72, "scope": "global" }
  ]
}
```

### Scenario: autoRecall 有結果
- GIVEN autoRecall enabled，使用者訊息觸發
- WHEN `retrieveWithRetry()` 回傳 N > 0 筆結果
- THEN append 一行 JSON 到 `{recallLogDir}/auto-recall-log.jsonl`
- AND 每個 hit 包含 `id`、`score`、`scope`
- AND `source` 固定為 `"auto-recall"`

### Scenario: autoRecall 無結果
- GIVEN autoRecall 回傳 0 筆結果
- THEN 不寫入任何記錄

### Scenario: autoRecall 失敗
- GIVEN `retrieveWithRetry()` 拋錯
- THEN 不寫入記錄，既有 error handling 不受影響

### Scenario: appendFile 失敗
- GIVEN appendFile 拋錯（磁碟滿、權限錯誤）
- THEN lancedb-pro `logger.warn()` 記錄一次，不影響 autoRecall 回應
- AND prependContext 照常注入 agent

## Requirement: JSONL File Path

### 預設路徑
`~/.openclaw/memory/autodream-reports/auto-recall-log.jsonl`

### Config key
`plugins.entries.memory-lancedb-pro.config.recallLogDir`

預設值：`~/.openclaw/memory/autodream-reports/`

lancedb-pro 寫入 `{recallLogDir}/auto-recall-log.jsonl`。
autodream 既有的 recall-log 路徑也在同一個目錄。

## Requirement: autodream 讀取 autoRecall Log

autodream 的 `RecallTracker.readLog()` SHALL 同時讀取兩個檔案：

1. `recall-log.jsonl`（既有，tool-call 來源）
2. `auto-recall-log.jsonl`（新增，autoRecall 來源）

### Scenario: 兩個 log 合併
- GIVEN 兩個 JSONL 檔都存在
- WHEN autodream 執行 Deep Promotion 或 staleness analysis
- THEN 所有 entries 合併處理，按 `ts` 排序
- AND `source` 欄位用來區分來源（可選的分析維度）

### Scenario: auto-recall-log.jsonl 不存在
- GIVEN 檔案不存在（lancedb-pro 未啟用 / 首次啟動）
- THEN 略過，只讀 recall-log.jsonl（向後相容）

### Scenario: Entries 格式相容
- autoRecall log 的 entry 格式與 tool-call log 相同
- 唯一差異是 `source` 欄位值
- RecallTracker 既有的 `getStats()`、`prune()` 方法不需改動
- 只有 `readLog()` 需要改動（合併兩個來源）

## Requirement: Log Rotation

autoRecall log 遵循 autodream 既有的 `recallLogMaxEntries` / `recallLogMaxAge` config。
autodream 在 prune 時同時 prune 兩個 log 檔。
