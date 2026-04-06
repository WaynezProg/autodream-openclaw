# autoDream Dreaming Phases — 實作規格書

> **Version:** 1.0  
> **Date:** 2026-04-07  
> **Author:** 芙莉蓮（COO）  
> **Assignee:** Kurisu  
> **Repo:** `~/.openclaw/workspace/projects/autodream-openclaw`

---

## 背景

OpenClaw 2026.4.5 內建了 `memory-core` 的 Dreaming 功能（Light/Deep/REM 三階段），但我們的記憶後端是 `memory-lancedb-pro`（佔據 memory plugin slot），兩者不相容。

現有 autoDream plugin 只做「整理」（dedup、time fix、conflict、staleness），缺少「升級」（promotion to MEMORY.md）和「反思」（pattern extraction）。

本 spec 目標：**把內建 dreaming 的核心價值移植到 autoDream**，不動 plugin slot。

---

## 現有架構

```
src/
├── index.ts                      # plugin entry
├── dream-engine.ts               # runDream() 主引擎
├── dream-service.ts              # 背景排程
├── lancedb-adapter.ts            # LanceDB 讀寫
├── analysis/
│   ├── dedup-detector.ts         # cosine + jaccard 重複偵測
│   ├── dedup-merger.ts           # LLM merge
│   ├── conflict-detector.ts      # 規則 + LLM 矛盾偵測
│   ├── staleness-scorer.ts       # 多因子過期評分
│   ├── time-normalizer.ts        # 相對時間→絕對日期
│   └── llm-helper.ts             # LLM 呼叫（subagent / HTTP）
├── report/
│   └── reporter.ts               # markdown report 生成
├── tools/
│   ├── dream-trigger.ts          # dream_now tool
│   └── dream-status.ts           # dream_status tool
├── cli/
│   └── dream-cli.ts              # CLI 命令
tests/
├── *.test.ts                     # vitest 測試
```

**依賴:** `@lancedb/lancedb`, `@sinclair/typebox`, `openclaw/plugin-sdk`  
**Build:** `tsc` → `dist/`  
**Test:** `vitest run`

---

## 新增功能

### Task 1: Recall Tracker（記憶召回追蹤器）

**目的：** 記錄每次 memory_recall 的查詢與命中，為 Deep Promotion 累積評分數據。

#### 1.1 新增檔案

```
src/tracking/recall-tracker.ts
```

#### 1.2 資料結構

```typescript
// 追蹤 log 的單筆記錄
interface RecallLogEntry {
  ts: number;           // epoch ms
  query: string;        // 使用者查詢文字
  agentId?: string;     // 哪個 agent 觸發的
  hits: RecallHit[];    // 命中的記憶
}

interface RecallHit {
  id: string;           // memory ID
  score: number;        // recall score (0-1)
}

// 統計摘要（供 Deep phase 使用）
interface RecallStats {
  memoryId: string;
  totalRecalls: number;       // 總被召回次數
  uniqueQueries: number;      // 被多少不同 query 召回
  avgScore: number;           // 平均 recall score
  lastRecalledAt: number;     // 最近一次被召回的 epoch ms
  daySpan: number;            // 跨越幾天被召回（consolidation signal）
}
```

#### 1.3 儲存

- **路徑：** `~/.openclaw/memory/autodream-reports/recall-log.jsonl`
- **格式：** 每行一筆 JSON（JSONL），append-only
- **旋轉策略：** 超過 10MB 或 90 天時，舊資料移至 `recall-log.YYYY-MM.jsonl.gz`（Optional，v1 先不做，只保留 90 天內的記錄）

#### 1.4 Hook 方式

在 `index.ts` 的 `register()` 中加入：

```typescript
api.on("tool_result", async (event, ctx) => {
  // 只追蹤 memory_recall 的結果
  if (event.toolName !== "memory_recall") return;
  recallTracker.record(event, ctx);
});
```

**注意：** 檢查 plugin SDK 的 `tool_result` event 是否包含 `toolName` 和 result payload。若 SDK 不支援 `tool_result` event，改用 `agent_end` 事件解析 messages 中的 memory_recall 呼叫。

**Fallback 方案（若 tool_result event 不可用）：**

```typescript
api.on("agent_end", async (event, ctx) => {
  // 從 event.messages 中找出 memory_recall tool calls 和 results
  for (const msg of event.messages) {
    if (msg.role === "tool" && msg.toolName === "memory_recall") {
      recallTracker.recordFromMessage(msg, ctx);
    }
  }
});
```

#### 1.5 API

```typescript
class RecallTracker {
  constructor(logDir: string);
  
  // 記錄一次 recall event
  async record(event: ToolResultEvent, ctx: AgentContext): Promise<void>;
  
  // 讀取統計（供 Deep phase 使用）
  async getStats(options?: {
    since?: number;        // epoch ms, 只算這之後的
    minRecalls?: number;   // 至少被召回幾次才列入
  }): Promise<RecallStats[]>;
  
  // 清理過期記錄
  async prune(maxAgeDays?: number): Promise<number>;
}
```

#### 1.6 測試

```
tests/recall-tracker.test.ts
```

- 寫入 → 讀取 → 統計正確
- prune 刪除過期
- 空 log 回傳空陣列
- 同一 memory 被不同 query 召回 → uniqueQueries 正確計算
- daySpan 跨天計算

---

### Task 2: Deep Promotion（記憶升級）

**目的：** 把被反覆召回的高價值記憶升級到 `MEMORY.md`，成為持久知識。

#### 2.1 新增檔案

```
src/analysis/deep-promoter.ts
```

#### 2.2 評分模型

仿照內建 dreaming 的 6 維加權，但資料來源改為 LanceDB + Recall Tracker：

| 信號 | 權重 | 來源 | 說明 |
|---|---|---|---|
| frequency | 0.24 | RecallStats.totalRecalls | 被召回次數 |
| relevance | 0.30 | RecallStats.avgScore | 平均 recall 品質 |
| queryDiversity | 0.15 | RecallStats.uniqueQueries | 被多少不同查詢召回 |
| recency | 0.15 | RecallStats.lastRecalledAt | 時間衰減（halfLife = 14 天） |
| consolidation | 0.10 | RecallStats.daySpan | 跨天出現頻率 |
| richness | 0.06 | 文字分析 | keyword/概念密度 |

**正規化：** 每個信號正規化到 0-1 再加權。

```typescript
interface DeepCandidate {
  memory: MemoryRecord;
  recallStats: RecallStats;
  signals: {
    frequency: number;     // 0-1
    relevance: number;     // 0-1
    queryDiversity: number;// 0-1
    recency: number;       // 0-1
    consolidation: number; // 0-1
    richness: number;      // 0-1
  };
  score: number;           // 加權總分 0-1
}
```

**正規化公式：**

```
frequency    = min(totalRecalls / 10, 1)          # 10 次算滿分
relevance    = avgScore                            # 已經是 0-1
queryDiversity = min(uniqueQueries / 5, 1)        # 5 個不同 query 算滿分
recency      = exp(-ln(2) * daysSinceLastRecall / 14)
consolidation = min(daySpan / 7, 1)               # 跨 7 天算滿分
richness     = min(uniqueKeywords / 15, 1)        # 15 個 keyword 算滿分
```

#### 2.3 門檻

```typescript
interface DeepPromotionConfig {
  minScore: number;           // 0.65（低於內建的 0.8，因為我們資料量較少）
  minRecallCount: number;     // 3
  minUniqueQueries: number;   // 2（低於內建的 3）
  maxPromotionsPerRun: number; // 5
  recencyHalfLifeDays: number; // 14
  maxAgeDays: number;         // 30（超過 30 天沒被 recall 不考慮升級）
}
```

#### 2.4 已升級去重

不重複升級已在 MEMORY.md 中的內容：

```typescript
// 讀取現有 MEMORY.md 內容
// 對每個 candidate，用 fuzzy match 檢查是否已存在相似內容
// 用 LLM 做最終確認（可選）
```

#### 2.5 MEMORY.md 寫入格式

```markdown
## Deep Promotion（auto-promoted）

- **{category}**（{date}）：{refined_text}
  - 來源 memory ID: `{id}`
  - 升級分數: {score}
```

**寫入位置：** append 到 MEMORY.md 尾部的 `## Deep Promotion（auto-promoted）` section。若 section 不存在則建立。

#### ⚠️ Scope 限制（重要）

**只升級 `global` 和 `business` scope 的記憶。** Agent-specific scope（如 `agent:kurisu`、`agent:yukino` 等）和 `personal` scope 的記憶一律不寫入 MEMORY.md。

原因：MEMORY.md 是 workspace 層級的共用檔案，所有 agent 啟動時都會讀到。如果把 agent-specific 記憶寫進去，等於 scope 洩漏——其他 agent 會看到不屬於自己的記憶。

```typescript
const PROMOTABLE_SCOPES = ["global", "business"];

// 在篩選 candidates 時過濾
candidates = candidates.filter(c => 
  PROMOTABLE_SCOPES.includes(c.memory.scope)
);
```

如果未來需要升級 agent-specific 記憶，應寫入各 agent 自己的目錄（如 `agents/<agentId>/MEMORY.md`），但 v1 不做。

#### 2.6 LLM 精煉

升級前用 LLM 把記憶精煉成適合 MEMORY.md 的格式：

```
Prompt: 
  "Refine this memory into a concise, self-contained knowledge entry for MEMORY.md.
   Keep key facts, dates, and decisions. Remove session-specific noise.
   Output the refined text only, in the same language as the input."
   
   Memory: {text}
   Category: {category}
   Scope: {scope}
```

#### 2.7 測試

```
tests/deep-promoter.test.ts
```

- 分數計算正確（已知 stats → 已知 score）
- 門檻過濾（低於 minScore 的被排除）
- 去重邏輯（已在 MEMORY.md 的不重複升級）
- maxPromotionsPerRun 上限

---

### Task 3: REM Reflection（主題反思）

**目的：** 每週從 recall patterns 中萃取主題趨勢，寫入 DREAMS.md。

#### 3.1 新增檔案

```
src/analysis/rem-reflector.ts
```

#### 3.2 排程

- **頻率：** 每週日一次（隨 dream-service 的排程觸發，但只在週日執行）
- **觸發條件：** 該週有至少 10 筆 recall log

#### 3.3 分析維度

```typescript
interface RemReflection {
  period: string;              // "2026-W14"
  themes: ThemeEntry[];        // 本週反覆出現的主題
  emergingTopics: string[];    // 新出現但被多次查詢的主題
  fadingTopics: string[];      // 過去常查但本週消失的主題
  summary: string;             // LLM 生成的一段摘要
}

interface ThemeEntry {
  theme: string;               // 主題名稱
  queryCount: number;          // 相關查詢次數
  topMemories: string[];       // 最常被召回的 memory IDs (top 3)
  strength: number;            // 0-1，主題強度
}
```

#### 3.4 實作邏輯

1. 從 recall-log.jsonl 讀取本週所有 query
2. 用 keyword clustering 或 LLM 做 query → theme 歸類
3. 對比上一週的 themes，找出 emerging 和 fading
4. 用 LLM 生成一段 1-3 句的自然語言摘要

#### 3.5 DREAMS.md 寫入格式

```markdown
## REM — Week 14 (2026-03-31 ~ 2026-04-06)

**主題：** 代購定價 (12次), autoDream 設定 (8次), HA 自動化 (5次)

**新浮現：** autoDream 設定, LCM 壓縮策略
**逐漸消退：** Claw Social 部署

> 本週的焦點從代購營運延伸到基礎設施最佳化。autoDream 和 LCM 的反覆查詢
> 顯示系統正在進入一個記憶管理的調整期。
```

#### ⚠️ Scope 限制

**Theme 分析只納入 `global` 和 `business` scope 的 recall logs。** Agent-specific scope 的查詢不列入主題統計，避免在共用的 DREAMS.md 中洩漏 agent 專屬資訊。

```typescript
const REFLECTABLE_SCOPES = ["global", "business"];
// 讀取 recall log 時過濾 scope
```

**檔案位置：** workspace root 的 `DREAMS.md`。若不存在則建立，header：

```markdown
# DREAMS.md — Dream Diary

> Auto-generated by autoDream REM phase. Do not edit the managed sections.
```

#### 3.6 測試

```
tests/rem-reflector.test.ts
```

- theme extraction 正確
- emerging/fading detection 正確
- 空 recall log → 跳過，不寫入

---

## Dream Engine 整合

### 修改 `dream-engine.ts`

在現有的 `runDream()` 流程中加入新 phases：

```
現有流程：
  scan → dedup → time → conflict → stale → [LLM refinement] → report

新流程：
  scan → dedup → time → conflict → stale → [LLM refinement]
       → [Deep Promotion]    ← 新增
       → [REM Reflection]    ← 新增（僅週日）
       → report
```

### 新增 Config

在 `DreamEngineConfig` 加入：

```typescript
interface DreamEngineConfig {
  // ... 現有欄位 ...
  
  // Deep Promotion
  deepEnabled: boolean;              // default: true
  deepMinScore: number;              // default: 0.65
  deepMinRecallCount: number;        // default: 3
  deepMinUniqueQueries: number;      // default: 2
  deepMaxPromotionsPerRun: number;   // default: 5
  deepRecencyHalfLifeDays: number;   // default: 14
  
  // REM Reflection
  remEnabled: boolean;               // default: true
  remMinWeeklyRecalls: number;       // default: 10
  
  // Recall Tracker
  recallLogDir: string;              // default: ~/.openclaw/memory/autodream-reports
  recallMaxAgeDays: number;          // default: 90
}
```

### 修改 `dream-service.ts`

`DreamServiceConfig` 加入對應欄位，從 `pluginConfig` 讀取。

### 修改 `reporter.ts`

`DreamReport` 加入：

```typescript
interface DreamReport {
  // ... 現有欄位 ...
  promotions?: {
    count: number;
    entries: Array<{
      memoryId: string;
      score: number;
      refinedText: string;
    }>;
  };
  reflection?: {
    period: string;
    themes: Array<{ theme: string; queryCount: number; strength: number }>;
    summary: string;
  };
}
```

---

## Plugin Config（openclaw.json）

新增可配置欄位：

```jsonc
{
  "plugins": {
    "entries": {
      "autodream": {
        "config": {
          // ... 現有 ...
          
          // Phase 1: Recall Tracker (自動啟用)
          "recallMaxAgeDays": 90,
          
          // Phase 2: Deep Promotion
          "deepEnabled": true,
          "deepMinScore": 0.65,
          "deepMinRecallCount": 3,
          "deepMinUniqueQueries": 2,
          "deepMaxPromotionsPerRun": 5,
          
          // Phase 3: REM Reflection
          "remEnabled": true,
          "remMinWeeklyRecalls": 10
        }
      }
    }
  }
}
```

---

## Tool 更新

### dream_status 增強

回傳新增：

```typescript
{
  // ... 現有 ...
  recallTracker: {
    totalEntries: number;
    oldestEntry: string;     // ISO date
    topRecalledMemories: Array<{ id: string; count: number }>;
  };
  lastPromotion: {
    date: string;
    count: number;
    entries: string[];       // promoted memory IDs
  } | null;
  lastReflection: {
    period: string;
    themes: string[];
  } | null;
}
```

### dream_now 增強

新增參數：

```typescript
{
  // ... 現有 ...
  skipDeep?: boolean;    // 跳過 Deep Promotion
  skipRem?: boolean;     // 跳過 REM Reflection
  forceRem?: boolean;    // 強制跑 REM（不管是否週日）
}
```

---

## 實作順序與注意事項

### 順序

```
Phase 1: Recall Tracker (Task 1)
  ├─ src/tracking/recall-tracker.ts
  ├─ index.ts hook 註冊
  ├─ tests/recall-tracker.test.ts
  └─ build & test 通過

Phase 2: Deep Promotion (Task 2)  ← 依賴 Phase 1
  ├─ src/analysis/deep-promoter.ts
  ├─ dream-engine.ts 整合
  ├─ reporter.ts 更新
  ├─ tests/deep-promoter.test.ts
  └─ build & test 通過

Phase 3: REM Reflection (Task 3)  ← 依賴 Phase 1
  ├─ src/analysis/rem-reflector.ts
  ├─ dream-engine.ts 整合
  ├─ dream-service.ts 週日判斷
  ├─ reporter.ts 更新
  ├─ tests/rem-reflector.test.ts
  └─ build & test 通過

Phase 4: 整合 & Config
  ├─ dream-service.ts config 更新
  ├─ tool 更新（dream_status, dream_now）
  └─ 全量測試
```

### 注意事項

1. **不動現有模組的公開 API** — dedup-detector、conflict-detector 等維持原樣
2. **LLM 呼叫預算** — Deep + REM 可能需要額外 LLM calls。建議 `llmMaxCalls` 從 10 提升到 20，或分開計數
3. **MEMORY.md 寫入要 atomic** — 讀 → 修改 → 寫，用 fs rename 確保不會半寫
4. **plugin SDK event 探查** — 最優先確認 `tool_result` event 是否可用。若不行要用 `agent_end` fallback
5. **Recall Tracker 是被動的** — 它只記錄，不影響現有 recall 效能。JSONL append 很快
6. **REM 的 theme clustering** — v1 可以用 LLM 做 query 歸類（比較簡單），不需要自建 clustering 演算法
7. **已升級去重** — Deep Promotion 要讀 MEMORY.md，用簡單的文字比對（substring match）即可，不需要 embedding
8. **Build 目標** — TypeScript ESM，跟現有 tsconfig.json 一致（target ES2022, module Node16）
9. **測試** — 用 vitest，mock LanceDB adapter 和 LlmHelper
10. **workspace 路徑** — MEMORY.md 和 DREAMS.md 的路徑從 OpenClaw config 的 `agents.defaults.workspace` 取得，fallback `~/.openclaw/workspace`
11. **Scope 邊界** — Deep Promotion 和 REM Reflection 都只處理 `global` + `business` scope 的記憶/recall logs。Agent-specific scope（`agent:*`）和 `personal` scope 不寫入共用 md 檔案，避免 scope 洩漏。這是硬性規則，不可透過 config 關閉

---

## 驗收標準

- [ ] `npm run build` 無 error
- [ ] `npm run test` 全部通過
- [ ] Recall Tracker 能追蹤 recall events 並產出正確 stats
- [ ] Deep Promotion 能評分、過濾、精煉、寫入 MEMORY.md
- [ ] REM Reflection 能在週日產出 theme 分析寫入 DREAMS.md
- [ ] dream_status 顯示新增的 tracker/promotion/reflection 狀態
- [ ] dream_now 支援 skipDeep/skipRem/forceRem 參數
- [ ] 不影響現有 dedup/time/conflict/stale 功能
- [ ] 報告（markdown）包含 promotion 和 reflection sections
