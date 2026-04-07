# autoDream — Memory Consolidation Plugin

自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間，追蹤召回頻率，升級高價值知識，產出週報反思。支援 LLM 輔助分析（OpenAI / Anthropic）。

## 功能總覽

### 基礎整理（每日凌晨 4 點自動執行）

| 模組 | 說明 | LLM 輔助 |
|------|------|----------|
| **重複偵測** | cosine similarity + keyword overlap，自動合併 | ✅ 合併文字 |
| **時間正規化** | 相對時間（昨天、3天前）→ 絕對時間，寫回 LanceDB | ✅ 模糊時間解析 |
| **矛盾偵測** | 啟用/停用、是/不是、key=value 衝突 | ✅ 確認矛盾 |
| **過時評分** | ageDays × importance，可自動刪除 | ❌ |

### 進階功能（Dreaming Phases）

| 階段 | 說明 | 觸發時機 |
|------|------|----------|
| **Recall Tracker** | 追蹤每次 `memory_recall` 的查詢與命中，累積 JSONL log | 即時（每次 recall 自動記錄） |
| **Deep Promotion** | 高頻召回記憶 → LLM 精煉 → 寫入 MEMORY.md | 每日（凌晨 4 點，需 recall 數據） |
| **REM Reflection** | 分析一週 recall 主題趨勢 → 寫入 DREAMS.md | 每週日（需至少 10 次 recall） |

---

## Recall Tracker

追蹤所有 agent 的 `memory_recall` 呼叫，記錄：

- **查詢內容**（query）
- **命中記憶**（memory ID、score、scope）
- **觸發 agent**（agentId）
- **時間戳**（ts）

資料存於 `~/.openclaw/memory/autodream-reports/recall-log.jsonl`。

透過 plugin hook 自動運作：優先使用 `tool_result` event，若 SDK 不支援則 fallback 到 `agent_end` event 從 messages 中擷取。

用途：
- 為 Deep Promotion 和 REM Reflection 提供數據
- 辨識哪些記憶真正有在被使用
- 為 staleness scoring 提供實際依據

---

## Deep Promotion

每日掃描 recall 統計，將符合條件的記憶升級到 `MEMORY.md`（workspace context，所有 agent 啟動時自動載入）。

### 6 維評分

| 維度 | 權重 | 說明 |
|------|------|------|
| frequency | 0.24 | 被召回次數（/ 10） |
| relevance | 0.30 | 平均 recall score |
| queryDiversity | 0.15 | 不同查詢的數量（/ 5） |
| recency | 0.15 | 最近被召回的時間（指數衰減） |
| consolidation | 0.10 | 跨越的天數（/ 7） |
| richness | 0.06 | keyword 數量（/ 15） |

### 升級門檻

- 總分 ≥ 0.65
- 至少被 3 次 recall 命中
- 至少 2 個不同查詢命中
- 最近 30 天內有被召回

### Scope 安全

**硬性規則：只升級 `global` + `business` scope 的記憶。** `personal`、`agent:*` 等 scope 的記憶不會寫入 MEMORY.md，防止 agent-specific 知識洩漏到共用 context。

升級後的記憶以 `## Deep Promotion（auto-promoted）` 區塊寫入 MEMORY.md，包含：
- 精煉後文字（LLM rewrite）
- 來源 memory ID
- 升級分數

已存在的內容會自動去重（Jaccard > 0.7 視為重複）。

---

## REM Reflection

每週日分析 recall 查詢模式，產出主題趨勢報告寫入 `DREAMS.md`。

### 分析內容

- **主題聚類**：以 keyword overlap 將查詢分群
- **新浮現主題**：本週有、上週沒有
- **消退主題**：上週有、本週沒有
- **LLM 摘要**：1-3 句反思

### Scope 安全

recall entries 在分析前經過 scope 過濾，只包含命中 `global` + `business` scope 記憶的查詢。沒有 scope 的舊 log 預設通過（向後相容）。

### 觸發條件

- 週日才執行（或 `forceRem: true`）
- 當週至少 10 次 recall（scope 過濾後）

---

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

### Agent Tools

- `dream_now` — 立即執行 dream（支援 `dryRun`、`scope`、`skipDeep`、`skipRem`、`forceRem`）
- `dream_status` — 查詢記憶庫狀態、recall 統計、上次升級/反思結果

### 背景服務

每天指定時間自動執行（`scheduleHour`，預設 4 點）。排程有完整錯誤處理——單次失敗不中斷後續排程。

---

## 設定

在 `openclaw.json` 的 `plugins.entries.autodream.config` 中：

```json
{
  "plugins": {
    "entries": {
      "autodream": {
        "enabled": true,
        "config": {
          "scheduleHour": 4,
          "allowedScopes": ["global", "business", "personal", "agent:main"],
          "autoMergeDuplicates": true,
          "autoFixTime": true,
          "autoDeleteStale": true,
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
| `scheduleHour` | number | 4 | 每日執行時間（0-23） |
| `minSessionsSinceLastRun` | number | 3 | 最少 session 數才觸發 |
| `dedupThreshold` | number | 0.90 | 重複偵測閾值 |
| `maxChangesPerRun` | number | 20 | 每次最多修改數 |
| `staleAgeDays` | number | 60 | 過時天數閾值 |
| `scanLimit` | number | 5000 | 每次掃描記憶上限 |
| `allowedScopes` | string[] | `["global"]` | 允許掃描的 scope |
| `autoMergeDuplicates` | boolean | false | 自動合併重複 |
| `autoFixTime` | boolean | false | 自動轉換相對時間 |
| `autoDeleteStale` | boolean | false | 自動刪除過時 |

### Deep Promotion 設定

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `deepEnabled` | boolean | true | 啟用 Deep Promotion |
| `deepMinScore` | number | 0.65 | 升級最低分數 |
| `deepMinRecallCount` | number | 3 | 最少召回次數 |
| `deepMinUniqueQueries` | number | 2 | 最少不同查詢數 |
| `deepMaxPromotionsPerRun` | number | 5 | 每次最多升級筆數 |
| `deepRecencyHalfLifeDays` | number | 14 | recency 半衰期（天） |

### REM Reflection 設定

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `remEnabled` | boolean | true | 啟用 REM Reflection |
| `remMinWeeklyRecalls` | number | 10 | 一週最少 recall 次數才產出 |

### LLM 設定

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `llmEnabled` | boolean | true | 啟用 LLM 輔助分析 |
| `llmProvider` | string | `"openai"` | `"openai"` 或 `"anthropic"` |
| `llmModel` | string | `"gpt-4o"` | 模型 ID |
| `llmBaseUrl` | string | - | 自訂 API URL |
| `llmApiKey` | string | - | API key（fallback 到環境變數） |
| `llmMaxCalls` | number | 10 | 每次最多 LLM 呼叫數 |

### Recall Tracker 設定

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `recallLogDir` | string | `~/.openclaw/memory/autodream-reports` | recall log 存放路徑 |
| `recallMaxAgeDays` | number | 90 | log 保留天數（超過自動清除） |

---

## 檔案輸出

```
~/.openclaw/workspace/
├── MEMORY.md          ← Deep Promotion 寫入（auto-promoted 區塊）
├── DREAMS.md          ← REM Reflection 週報
│
~/.openclaw/memory/autodream-reports/
├── recall-log.jsonl   ← Recall Tracker 即時記錄
├── dream-2026-04-07T04-00-00-000Z.md  ← 每日報告
└── ...
```

---

## 安全性

- LanceDB scope filter 有 SQL injection 防護
- Deep Promotion 只升級 `global` + `business` scope（硬性規則，不可由 config 覆蓋）
- REM Reflection 過濾 agent-specific recall entries
- Config 數值解析有 NaN 防護，布林值正確處理 `"false"` 字串
- 重複合併遵守 `maxChangesPerRun` 上限
- MEMORY.md / DREAMS.md 使用 atomic write（tmp → rename）
- 背景服務有 try-catch，單次失敗不影響排程

---

## 部署建議

### 第 1 週：觀察
- Recall Tracker 自動收集數據
- 基礎整理跑 dry-run，看報告確認準確度

### 第 2 週：開啟自動化
- `autoMergeDuplicates: true`
- `autoFixTime: true`
- Deep Promotion 開始有候選（取決於 recall 頻率）

### 第 3 週+：完整運作
- 第一份 DREAMS.md 週報產出
- 根據 recall 數據調整 threshold
- 可考慮開啟 `autoDeleteStale: true`

---

## 開發

```bash
npm install
npm run build
npm test
```

測試覆蓋：183 tests（dedup、conflict、staleness、time-normalizer、llm-helper、dream-service、dream-cli、recall-tracker、deep-promoter、rem-reflector）
