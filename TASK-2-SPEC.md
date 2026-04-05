# Task 2: Analysis Modules — time-normalizer, conflict-detector, staleness-scorer

## 背景

Task 1 已完成：plugin 骨架、dedup-detector、dream_now/dream_status tools、LanceDB adapter、reporter。
Task 2 要補上剩下三個 analysis 模組，並整合進 dream-engine。

## 現有 Code 結構

```
src/
├── index.ts                    ← Plugin entry (已有 agent_end hook placeholder)
├── dream-engine.ts             ← 核心引擎（目前只跑 dedup）
├── lancedb-adapter.ts          ← LanceDB 讀取（MemoryRecord 有 id/text/category/scope/importance/timestamp/metadata/vector）
├── tools/
│   ├── dream-trigger.ts        ← dream_now tool
│   └── dream-status.ts         ← dream_status tool
├── analysis/
│   └── dedup-detector.ts       ← ✅ 已完成
└── report/
    └── reporter.ts             ← 報告生成
tests/
└── dedup-detector.test.ts      ← 17 unit tests
```

## MemoryRecord Schema（已驗證）

```typescript
interface MemoryRecord {
  id: string;
  text: string;
  category: string;       // "preference" | "fact" | "decision" | "entity" | "other"
  scope: string;
  importance: number;      // 0-1
  timestamp: number;       // epoch ms
  metadata: string;        // JSON string
  vector: number[];        // 1536d float array
}

// metadata JSON 可能包含（但不保證都有）：
interface ParsedMetadata {
  tier?: "core" | "working" | "peripheral";
  access_count?: number;
  confidence?: number;
  last_accessed_at?: number;
  valid_from?: number;
  invalidated_at?: number;
  // ... 更多
}
```

已有 helper：`parseMetadata(raw: string): ParsedMetadata`（在 lancedb-adapter.ts）。

## 要做的三個模組

### 1. time-normalizer.ts (`src/analysis/time-normalizer.ts`)

偵測記憶文字中的**相對時間**，計算出對應的絕對日期。

```typescript
export interface TimeFixEntry {
  memory: MemoryRecord;
  original: string;          // 匹配到的原始片段，如 "昨天"、"3天前"
  resolved: string;          // 轉換後的絕對日期，如 "2026-04-04"
  newText: string;           // 替換後的完整文字
  confidence: "high" | "low"; // high = 明確（昨天、3天前），low = 模糊（最近、前陣子）
}

export function detectRelativeTime(memories: MemoryRecord[]): TimeFixEntry[];
```

**Pattern 規則：**

| Pattern | 類型 | 範例 | confidence |
|---------|------|------|------------|
| `昨天` | 精確 | → memory.timestamp - 1day | high |
| `前天` | 精確 | → memory.timestamp - 2days | high |
| `N天前`/`N日前` | 精確 | → memory.timestamp - N days | high |
| `上週`/`上個星期` | 精確 | → memory.timestamp - 7days | high |
| `上個月` | 精確 | → memory.timestamp - 30days | high |
| `N週前`/`N個月前` | 精確 | → 計算 | high |
| `yesterday` | 精確 | → - 1day | high |
| `N days ago` | 精確 | → - N days | high |
| `last week`/`last month` | 精確 | → - 7/30 days | high |
| `今天`/`today`/`this week` | 精確 | → memory.timestamp 當天 | high |
| `最近`/`前陣子`/`recently`/`earlier` | 模糊 | 只標記不轉 | low |

**重要**：用 `memory.timestamp`（記憶建立時間）作為基準日，不是 `Date.now()`。

**替換規則**：只替換 `confidence: "high"` 的，`"low"` 只回報不改文字。

### 2. conflict-detector.ts (`src/analysis/conflict-detector.ts`)

偵測同 scope+category 內語意相似但結論矛盾的記憶對。

```typescript
export interface ConflictPair {
  a: MemoryRecord;
  b: MemoryRecord;
  similarity: number;         // cosine similarity
  reason: string;             // 矛盾原因描述
  ruleMatched: string;        // 匹配的規則名稱
}

export function detectConflicts(memories: MemoryRecord[]): ConflictPair[];
```

**偵測邏輯：**
1. 按 `scope` + `category` 分組（不跨 scope/category 比對）
2. 兩兩比對：cosine similarity 在 **0.60 ~ 0.85** 之間的（太高=重複已被 dedup 抓；太低=不相關）
3. 對這些候選對，跑矛盾規則：

| 規則名 | Affirm Pattern | Negate Pattern |
|--------|---------------|----------------|
| enable-disable | `/啟用\|開啟\|enable/` | `/停用\|關閉\|disable/` |
| complete-incomplete | `/已完成\|已做完\|completed/` | `/尚未完成\|還沒做\|未完成\|not.*completed/` |
| use-avoid | `/應該用\|使用\|推薦用/` | `/不要用\|避免\|不推薦/` |
| true-false | `/是\|正確\|true/` | `/不是\|錯誤\|false/` |
| value-conflict | 同一 key 有不同 value（regex: `(\w+)\s*[:=：]\s*(\S+)`） | — |

4. 所有矛盾標記為 `flag-for-review`，**不自動解決**。

**向量函式複用**：import `cosineSimilarity` from `dedup-detector.ts`。

### 3. staleness-scorer.ts (`src/analysis/staleness-scorer.ts`)

多因子過時評分。

```typescript
export interface StaleEntry {
  memory: MemoryRecord;
  score: number;              // 0-1，越高越過時
  factors: {
    ageDays: number;
    accessCount: number;
    importance: number;
    tier: string | undefined;
  };
}

export interface StalenessOptions {
  staleAgeDays?: number;          // 預設 60
  minAccessCount?: number;        // 預設 3
  maxImportance?: number;         // 預設 0.3
  scoreThreshold?: number;        // 預設 0.7
}

export function scoreAndFilterStale(
  memories: MemoryRecord[],
  opts?: StalenessOptions,
): StaleEntry[];
```

**評分公式：**
```
staleness = (age_factor * 0.4) + (access_factor * 0.3) + (importance_factor * 0.3)

age_factor = min(ageDays / staleAgeDays, 1.0)
access_factor = max(1 - access_count / minAccessCount, 0)
importance_factor = max(1 - importance, 0)
```

**access_count 取法**：`parseMetadata(m.metadata).access_count ?? 0`
**tier 保護**：`tier === "core"` 的記憶直接跳過，不評分。
**過濾**：`score >= scoreThreshold` 才進入結果，按 score 降序排列。

## 整合到 dream-engine.ts

更新 `runDream()` 讓它跑完整的四個模組：

```typescript
// Phase 2: Scan
const dedupPairs = detectDuplicates(memories, { vectorThreshold: config.dedupThreshold });
const timeIssues = detectRelativeTime(memories);
const conflicts = detectConflicts(memories);
const staleItems = scoreAndFilterStale(memories, { staleAgeDays: config.staleAgeDays });
```

## 更新 reporter.ts

DreamReport 擴充：

```typescript
interface DreamReport {
  timestamp: string;
  scanned: number;
  duplicates: { count: number; pairs: [...] };
  timeIssues: { count: number; entries: Array<{ id: string; original: string; resolved: string; confidence: string }> };
  conflicts: { count: number; pairs: Array<{ a: {...}; b: {...}; reason: string; ruleMatched: string }> };
  stale: { count: number; entries: Array<{ id: string; text: string; score: number; factors: {...} }> };
  dryRun: boolean;
}
```

`formatReportMarkdown()` 也要加上 Time Issues / Conflicts / Stale 三個 section。

## 更新 DreamEngineConfig

```typescript
interface DreamEngineConfig {
  dedupThreshold: number;
  maxChangesPerRun: number;
  autoMergeDuplicates: boolean;
  autoFixTime: boolean;       // NEW
  staleAgeDays: number;       // NEW
}
```

## 測試

建立以下測試檔：

1. **`tests/time-normalizer.test.ts`** — 至少 10 個 case：
   - 中文精確時間（昨天、前天、3天前、上週、上個月、2週前）
   - 英文精確時間（yesterday、3 days ago、last week）
   - 模糊時間（最近、recently）→ confidence: low
   - 無時間詞的記憶 → 不產出
   - 替換結果正確

2. **`tests/conflict-detector.test.ts`** — 至少 8 個 case：
   - enable-disable 矛盾
   - complete-incomplete 矛盾
   - use-avoid 矛盾
   - value-conflict（同 key 不同 value）
   - 不同 scope 的不算矛盾
   - similarity 太高（> 0.85）不算矛盾（那是 dedup 的事）
   - similarity 太低（< 0.60）不算矛盾

3. **`tests/staleness-scorer.test.ts`** — 至少 8 個 case：
   - 高 age + 低 access + 低 importance → 高 score
   - 新記憶 → 低 score（不在結果中）
   - core tier → 直接跳過
   - 邊界 case：score 剛好 0.7
   - 自訂 options

## 驗收標準

| 項目 | 標準 |
|------|------|
| `npx tsc` | 零 error |
| `npx vitest run` | 所有測試通過（含新增 + 舊的 17 個） |
| time-normalizer | 中英文相對時間偵測 + 轉換正確 |
| conflict-detector | 矛盾規則匹配正確，不跨 scope |
| staleness-scorer | 評分公式正確，core tier 跳過 |
| dream-engine | runDream() 跑完整四模組，報告包含所有 section |
| reporter | markdown 報告有 Duplicates / Time Issues / Conflicts / Stale 四段 |

## 注意事項

- 所有 import 使用 `.js` 後綴（ESM 規則）
- 複用 `cosineSimilarity` from `dedup-detector.ts`，不要重寫
- 複用 `parseMetadata` from `lancedb-adapter.ts`
- `MemoryRecord.timestamp` 是 epoch ms
- 測試用 mock data，不需要真的連 LanceDB
- **不要動** `dedup-detector.ts` 和 `dedup-detector.test.ts`（已通過）
- **不要動** `lancedb-adapter.ts`（已驗證 schema 正確）
- **不要改** tool name 和 tool signature（`dream_now`、`dream_status`）
