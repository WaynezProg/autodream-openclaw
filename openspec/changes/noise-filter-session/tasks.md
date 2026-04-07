# Tasks: Session Metadata Noise Pattern for Stale Cleaner

## Phase 1: 實作 Noise Pattern Matching

- [ ] 在 `src/modules/stale-cleaner.ts` 定義 `NoisePattern` interface 和 `DEFAULT_NOISE_PATTERNS`
- [ ] 實作 `isNoiseMemory(text, patterns)` function
- [ ] 在掃描 loop 開頭加入 noise 檢查：符合 pattern → dryRun 計數 / 否則刪除
- [ ] 在 `src/config.ts` 的 `StaleCleanerConfig` 加 `noisePatterns?` 欄位
- [ ] dream report 加入 `noiseDeleted` 計數
- [ ] `npm run build` 通過

## Phase 2: 測試

- [ ] 手動 `memory_store` 一條 text 以 `Session: 2026-04-04 ...` 開頭、包含 `Session Key:` 的記憶
- [ ] `dream_now(dryRun: true)` → 確認 report 顯示 `noiseDeleted >= 1`
- [ ] `dream_now(dryRun: false)` → 確認垃圾被刪除
- [ ] 確認正常 memory 不受影響
- [ ] gateway restart，確認 autodream 正常啟動

## Notes

- 預設 3 條 pattern，可透過 config 擴充
- 執行順序：noise check → staleness scoring（noise 直接刪，不進 scoring）
- 不動 lancedb-pro
