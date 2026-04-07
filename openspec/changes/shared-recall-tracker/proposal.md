# Proposal: Recall Tracker — autoRecall JSONL Bridge

## Intent

目前 recall-tracker 只追蹤手動 `memory_recall` tool call（透過 `tool_result` / `agent_end` event），但 autoRecall 佔了大部分記憶存取量，卻完全不被追蹤。這導致 autoDream 的 Deep Promotion（高頻記憶升級）和 staleness scoring（過期記憶清理）完全失效。

根本原因：autoRecall 在 lancedb-pro 的 `before_agent_start` hook 裡直接呼叫 `retriever.retrieve()`，不經過 tool call pipeline，RecallTracker 看不到。

## Scope

方案 B'：最小改動策略。

- **lancedb-pro**：autoRecall 完成後加一行 `appendFile`，把 recall event 寫進 JSONL 檔
- **autodream**：不改架構，只在 RecallTracker 啟動時同時讀 autoRecall 的 JSONL log
- **不建 shared package**、不改 plugin SDK、不用 event emit

## Approach

1. lancedb-pro：在 `before_agent_start` handler 裡，`retrieveWithRetry()` 回傳結果後，加一行 `appendFile` 寫 JSONL（fire-and-forget）
2. autodream：RecallTracker 的 `readLog()` 增加讀取 autoRecall JSONL 的邏輯，合併到 recall stats

lancedb-pro 改動量：**~10 行**（import fs.appendFile + format + write）
autodream 改動量：**~20 行**（readLog 合併第二個 JSONL source）

## Non-Goals

- 不建 shared npm package
- 不改變 recall-tracker 的既有 JSONL 格式
- 不改變 autoRecall 本身的檢索邏輯
- 不改變 lancedb-pro 的任何其他行為

## Impact

- autoRecall 存取開始被追蹤 → Deep Promotion 和 staleness 恢復有效
- 每次 autoRecall 多一次 appendFile I/O（< 1ms，fire-and-forget，不阻塞回應）
- 兩個 plugin 之間的耦合僅限於一個共用的 JSONL 檔案路徑

## Rollback

- lancedb-pro：刪除 appendFile 那幾行，回到不追蹤 autoRecall 的狀態
- autodream：移除讀取第二個 JSONL 的邏輯，回到只讀自己的 recall-log
