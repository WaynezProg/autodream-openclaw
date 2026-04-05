# autoDream — Memory Consolidation Plugin

自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間。支援 LLM 輔助分析（OpenAI / Anthropic）。

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
- `dream_status` — 查詢上次執行結果與模組狀態

### 背景服務

每天凌晨 3 點自動執行（可透過 `scheduleHour` 調整）。排程執行有完整錯誤處理——單次失敗不會中斷後續排程。

## 設定

在 `openclaw.json` 的 `plugins.entries.autodream.config` 中：

```json
{
  "plugins": {
    "entries": {
      "autodream": {
        "enabled": true,
        "config": {
          "scheduleHour": 3,
          "minSessionsSinceLastRun": 3,
          "dedupThreshold": 0.90,
          "staleAgeDays": 60,
          "autoMergeDuplicates": false,
          "autoFixTime": false,
          "autoDeleteStale": false,
          "llmProvider": "openai",
          "llmModel": "gpt-4o"
        }
      }
    }
  }
}
```

### 核心設定

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `intervalHours` | number | 24 | 最小執行間隔（小時） |
| `scheduleHour` | number | 3 | 每日執行時間（0-23） |
| `minSessionsSinceLastRun` | number | 3 | 最少 session 數才觸發 |
| `dedupThreshold` | number | 0.90 | 重複偵測閾值 |
| `maxChangesPerRun` | number | 20 | 每次最多修改數（包含 LLM merge） |
| `staleAgeDays` | number | 60 | 過時天數閾值 |
| `scanLimit` | number | 5000 | 每次掃描記憶上限 |
| `allowedScopes` | string[] | `["global"]` | 允許掃描的 scope |
| `autoMergeDuplicates` | boolean | false | 自動合併重複 |
| `autoFixTime` | boolean | false | 自動轉換相對時間 |
| `autoDeleteStale` | boolean | false | 自動刪除過時 |

### LLM 設定

LLM 用於進階分析：重複合併、矛盾確認、相對時間解析。

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `llmEnabled` | boolean | true | 啟用 LLM 輔助分析 |
| `llmProvider` | string | `"openai"` | LLM provider（`"openai"` 或 `"anthropic"`） |
| `llmModel` | string | `"gpt-4o"` | 模型 ID |
| `llmBaseUrl` | string | - | 自訂 API URL（如 Ollama `http://localhost:11434/v1`） |
| `llmApiKey` | string | - | API key（不設定則 fallback 到 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 環境變數） |
| `llmMaxCalls` | number | 10 | 每次 dream run 最多 LLM 呼叫數 |

## 分析模組

| 模組 | 說明 | LLM 輔助 |
|------|------|----------|
| **重複偵測** | cosine similarity + keyword overlap | ✅ 合併文字 |
| **時間正規化** | 相對時間（昨天、3天前）→ 絕對時間 | ✅ 模糊時間解析 |
| **矛盾偵測** | 啟用/停用、是/不是（含否定詞處理）、key=value 衝突 | ✅ 確認矛盾 |
| **過時評分** | ageDays × importance，分數 clamp ≥ 0 | ❌ |

## 安全性

- LanceDB scope filter 有 SQL injection 防護（自動 escape 單引號）
- Config 數值解析有 NaN 防護，布林值正確處理 `"false"` 字串
- 重複合併遵守 `maxChangesPerRun` 上限
- 背景服務有 try-catch，單次失敗不影響排程

## 報告位置

```
~/.openclaw/memory/autodream-reports/
├── dream-2026-04-06T03-00-00-000Z.md
└── ...
```

## 部署建議

### 第 1 週：Dry-Run
- 安裝 plugin，所有 auto 選項關閉
- 每天看報告，確認偵測準確度

### 第 2 週：Auto-Merge
- 開啟 `autoMergeDuplicates: true`
- 開啟 `autoFixTime: true`
- 矛盾和過時仍然只標記

### 第 3 週+：Full Auto
- 根據經驗決定是否開啟 `autoDeleteStale`
- 可調低 `dedupThreshold`（0.90 → 0.85）

## 開發

```bash
npm install
npm run build
npm test
```

測試：99 tests（dedup、conflict、staleness、time-normalizer、llm-helper、dream-service）
