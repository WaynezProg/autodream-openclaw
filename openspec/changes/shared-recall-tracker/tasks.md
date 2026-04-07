# Tasks: autoRecall JSONL Bridge

## Phase 1: lancedb-pro — 寫入 autoRecall log（~10 行）

- [ ] 在 `plugins/memory-lancedb-pro/index.ts` plugin init 階段，加 `mkdir` 確保 `recallLogDir` 存在
- [ ] 在 `before_agent_start` handler 裡，`retrieveWithRetry()` 回傳結果後，加 `appendFile` 寫入 `auto-recall-log.jsonl`
- [ ] fire-and-forget：`.catch()` 只 `logger.warn`，不阻塞 autoRecall 回應
- [ ] JSONL entry 格式：`{ ts, query, agentId, source: "auto-recall", hits: [{ id, score, scope }] }`
- [ ] query 截斷至 500 chars
- [ ] `npm run build` 通過

## Phase 2: autodream — 讀取 autoRecall log（~20 行）

- [ ] 在 `projects/autodream-openclaw/src/tracking/recall-tracker.ts` 的 `readLog()` 方法中，增加讀取 `auto-recall-log.jsonl`
- [ ] 合併兩個來源的 entries，按 `ts` 排序
- [ ] 若 `auto-recall-log.jsonl` 不存在，略過（不報錯）
- [ ] 在 `prune()` 方法中，同時 prune `auto-recall-log.jsonl`
- [ ] `npm run build` 通過

## Phase 3: Integration Test

- [ ] `openclaw gateway restart`
- [ ] 發一則訊息觸發 autoRecall
- [ ] 確認 `~/.openclaw/memory/autodream-reports/auto-recall-log.jsonl` 有新 entry
- [ ] 確認 entry 包含 `"source": "auto-recall"` + 正確的 `hits`
- [ ] 手動跑 `memory_recall` → 確認仍寫入 `recall-log.jsonl`（既有行為不變）
- [ ] `dream_now(dryRun: true)` → recall stats 應包含 autoRecall 資料

## Notes

- lancedb-pro 改動量極小（~10 行），不動任何既有邏輯
- 兩個 plugin 的耦合點只有 JSONL 檔案路徑和格式
- 預設路徑 `~/.openclaw/memory/autodream-reports/` 兩邊一致
- Rollback：lancedb-pro 刪掉 appendFile 那幾行即可
