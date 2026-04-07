# Proposal: Session Metadata Noise Cleanup via autoDream

## Intent

Smart Extraction 的 noise filter 未攔截 session metadata（如 `Session: 2026-04-04 17:15:25 UTC\nSession Key: agent:emilia:discord:...`），導致 46+ 條垃圾記憶被存入 DB，每條高達 16K chars，且同一條重複存多次。

## Scope

方案 B：不改 lancedb-pro，改由 autodream 的 stale-cleaner 模組事後清理。

- 在 autoDream 的 stale-cleaner 加入 pattern 規則，辨識並自動刪除 session metadata 垃圾
- 每天凌晨 3 點自動清理，不需人工介入

## Approach

在 autodream 的 stale-cleaner 模組中加入新的 noise pattern：
1. text 以 `Session:` 開頭且包含 `Session Key:` → 標記為 stale 並刪除
2. text 以 `Session ID:` 開頭 → 標記為 stale 並刪除
3. text 包含 `reflection-event · agent:` 且長度 < 200 → 標記為 stale 並刪除

## Non-Goals

- 不改 lancedb-pro 的 Smart Extraction noise filter（避免動 lancedb-pro）
- 不防止未來的 noise 進入（只做事後清理）

## Impact

- 每日自動清理 session metadata 垃圾
- 現有記憶中的垃圾會在下次 dream 時被清除
- 不影響任何正常功能

## Rollback

- 從 stale-cleaner 移除新增的 pattern 規則即可
