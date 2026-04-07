# Tasks: Re-embed After Merge

## Implementation

- [ ] 在 `src/dream-engine.ts` 的 `DreamEngineConfig` interface 加入 `embedder?: { embed(text: string): Promise<number[]> }` 欄位
- [ ] 找到所有 `store.update()` / `updateMemoryText()` 呼叫，在更新 text 後加入 re-embed 邏輯
- [ ] 在 `src/index.ts` 初始化 OpenAI embedder（用 `text-embedding-3-small`），傳入 dream-engine config
- [ ] 加入 error handling：embedding 失敗時 log warn，不 block merge
- [ ] 加入 re-embed 計數器，在 dream report 中顯示 `re-embedded: N memories`

## Verification

- [ ] `npm run build` 編譯通過
- [ ] 手動跑 `dream_now(dryRun: false)`，確認 log 有 re-embed 成功訊息
- [ ] 用 `memory_recall` 搜尋剛合併的記憶，確認能命中

## Notes

- embedder model 從 `autodream.config.embeddingModel` 讀取，預設 `text-embedding-3-small`
- OpenAI API key 從環境變數 `OPENAI_API_KEY` 取得（現有環境已有）
- LanceDB vector 欄位名稱需確認（可能是 `vector` 或 `embedding`）
