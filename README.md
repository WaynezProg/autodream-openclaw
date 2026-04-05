# autoDream — Memory Consolidation Plugin

自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間。

## 安裝

```bash
openclaw plugin install /path/to/autodream-openclaw
```

## 使用方式

### CLI 命令

```bash
# Dry-run（只看報告，不修改）
openclaw dream

# 限制特定 scope
openclaw dream --scope personal

# 實際執行修改
openclaw dream --no-dry-run
```

### Tools

- `dream_now` — 立即執行 dream（agent 可用）
- `dream_status` — 查詢上次執行結果

### 背景服務

每天凌晨 3 點自動執行（可透過 `scheduleHour` 調整）。

## 設定

在 `openclaw.yml` 中：

```yaml
plugins:
  entries:
    - location: /path/to/autodream-openclaw
      config:
        scheduleHour: 3
        minSessionsSinceLastRun: 3
        dedupThreshold: 0.90
        staleAgeDays: 60
        autoMergeDuplicates: false
        autoFixTime: false
        autoDeleteStale: false
```

### 設定選項

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `intervalHours` | number | 24 | 最小執行間隔（小時） |
| `scheduleHour` | number | 3 | 每日執行時間（0-23） |
| `minSessionsSinceLastRun` | number | 3 | 最少 session 數才觸發 |
| `notifyTarget` | string | - | Discord channel ID（可選） |
| `dedupThreshold` | number | 0.90 | 重複偵測閾值 |
| `maxChangesPerRun` | number | 20 | 每次最多修改數 |
| `staleAgeDays` | number | 60 | 過時天數閾值 |
| `autoMergeDuplicates` | boolean | false | 自動合併重複 |
| `autoFixTime` | boolean | false | 自動轉換相對時間 |
| `autoDeleteStale` | boolean | false | 自動刪除過時 |

## 部署計畫

### 第 1 週：Dry-Run
- 安裝 plugin，所有 auto 選項關閉
- 每天看報告，確認偵測準確度

### 第 2 週：Auto-Merge
- 開啟 `autoMergeDuplicates: true`
- 開啟 `autoFixTime: true`
- 矛盾和過時仍然只標記

### 第 3 週+：Full Auto
- 根據經驗決定是否開啟 `autoDeleteStale`
- 可調低 dedupThreshold（0.90 → 0.85）

## 分析模組

1. **重複偵測** — cosine similarity + keyword overlap
2. **時間正規化** — 相對時間 → 絕對時間
3. **矛盾偵測** — 啟用/停用、是/不是、key=value 衝突
4. **過時評分** — ageDays × importance

## 報告位置

```
~/.openclaw/memory/autodream-reports/
├── dream-2026-04-05T03-00-00-000Z.md
└── ...
```
