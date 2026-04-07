# Proposal: autoDream Merge Re-Embed

## Intent

autoDream 的 dedup/merge 流程在合併記憶後只更新 text，不重新產生 embedding vector。這導致合併後的記憶用舊 vector 存在 LanceDB 裡，recall 時用新 text 的語意搜不到，越合併品質越差。

## Scope

- 修改 `dream-engine.ts` 中所有呼叫 `store.updateMemoryText()` 或等效更新的地方
- 合併/更新 text 後，呼叫 embedder 產生新 vector，寫回 LanceDB
- 不改動 lancedb-pro 本體，只在 autodream 側處理

## Approach

1. 在 `dream-engine.ts` 找到所有 merge/dedup 操作中更新 text 的位置
2. 每次更新 text 後，呼叫 `embedder.embed(newText)` 取得新 vector
3. 用 LanceDB 的 `update()` 或 `delete + insert` 將新 vector + text 寫回
4. 如果 embedder 不可用（API 失敗），log warning 但不 block merge（graceful degradation）

## Impact

- 修復記憶品質隨時間劣化的根本問題
- 每次 merge 增加 1 次 embedding API call（text-embedding-3-small，成本極低）
- 不影響現有 merge 邏輯的其他行為

## Rollback

- 移除 re-embed 呼叫即可回到原行為
- 已合併但未 re-embed 的舊記憶不受影響（維持現狀）
