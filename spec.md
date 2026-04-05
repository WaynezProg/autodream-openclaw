# autoDream for OpenClaw — 技術規格（Plugin 版）

> Version: 2.1 | 2026-04-05 | Author: yukino
> 架構：OpenClaw Native Plugin（TypeScript ESM）
> ⚠️ v2.1 變更：移除 Skill 建議功能，獨立為 skillforge plugin

---

## 背景

### 問題

1. **記憶膨脹無人整理** — 目前 274 條記憶（global 154 / business 92 / personal 28），隨時間增長會出現重複、矛盾、過時的內容。目前仰賴各 agent 手動維護 MEMORY.md 和 daily notes，實際執行率低。
2. **daily notes 累積無人回顧** — GLOBAL.md 要求「每隔幾天回顧 daily notes 提煉精華」，但沒有自動機制觸發。

### 靈感來源

| 來源 | 機制 | 我們要借鏡什麼 |
|------|------|----------------|
| Claude Code autoDream | 閒置/session 結束時自動整理 MEMORY.md：合併重複、修矛盾、轉時間戳、刪過時 | 記憶自動整理的觸發與流程 |

---

## 架構概覽

```
openclaw-autodream/
├── package.json
├── openclaw.plugin.json           ← Plugin manifest
├── index.ts                       ← Plugin entry (definePluginEntry)
├── src/
│   ├── dream-service.ts           ← Background service (registerService)
│   ├── dream-engine.ts            ← 核心整理邏輯（純函式）
│   ├── tools/
│   │   ├── dream-trigger.ts       ← 手動觸發 tool (dream_now)
│   │   └── dream-status.ts        ← 查看狀態 tool (dream_status)
│   ├── analysis/
│   │   ├── dedup-detector.ts      ← 向量相似度 + 精確比對的重複偵測
│   │   ├── time-normalizer.ts     ← 相對時間轉絕對時間
│   │   ├── conflict-detector.ts   ← 矛盾偵測（語意對比 + 規則）
│   │   └── staleness-scorer.ts    ← 過時評分（age × access × importance）
│   └── report/
│       ├── reporter.ts            ← 報告生成
│       └── notifier.ts            ← 通知邏輯（有問題才通知 Wayne）
├── tests/
│   ├── dream-engine.test.ts
│   ├── dedup-detector.test.ts
│   └── time-normalizer.test.ts
└── README.md
```

---

## Plugin 註冊

```typescript
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

export default definePluginEntry({
  id: "autodream",
  name: "autoDream — Memory Consolidation",
  description: "自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間",
  register(api) {
    // 1. Background service — 定時執行
    api.registerService(createDreamService(api));

    // 2. Agent tools — 手動觸發 + 狀態查詢
    api.registerTool({
      name: "dream_now",
      description: "手動觸發 autoDream 記憶整理",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "指定 scope，不填則全部" })),
        dryRun: Type.Optional(Type.Boolean({ description: "預覽模式，不實際修改", default: false })),
      }),
      async execute(_id, params) { /* ... */ },
    });

    api.registerTool({
      name: "dream_status",
      description: "查看 autoDream 上次執行狀態和統計",
      parameters: Type.Object({}),
      async execute() { /* ... */ },
    });

    // 3. CLI 命令
    api.registerCli(async ({ program }) => {
      program
        .command("dream")
        .description("Manually trigger autoDream memory consolidation")
        .option("--dry-run", "Preview changes without applying")
        .option("--scope <scope>", "Target specific scope")
        .action(async (opts) => { /* ... */ });
    }, {
      descriptors: [{ name: "dream", description: "autoDream memory consolidation" }],
    });
  },
});
```

---

## Background Service（dream-service.ts）

```typescript
function createDreamService(api: OpenClawPluginApi) {
  return {
    id: "autodream-scheduler",
    
    async start() {
      const config = api.pluginConfig as AutoDreamConfig;
      const intervalMs = (config.intervalHours ?? 24) * 60 * 60 * 1000;
      const scheduleHour = config.scheduleHour ?? 3; // 預設凌晨 3 點
      
      scheduleNextRun(scheduleHour, intervalMs);
    },

    async stop() {
      clearScheduledRun();
    },
  };
}
```

---

## 核心引擎（dream-engine.ts）

不依賴 LLM，用程式碼精準控制：

```typescript
interface DreamResult {
  scanned: number;
  merged: DedupPair[];        // 合併的重複對
  timeFixed: TimeFixEntry[];  // 轉換的時間戳
  conflicts: ConflictPair[];  // 偵測到的矛盾
  stale: StaleEntry[];        // 標記為過時的
  errors: string[];
}

async function runDream(options: {
  scope?: string;
  dryRun?: boolean;
  maxChanges?: number;        // 預設 20
  dedupThreshold?: number;    // 預設 0.90
  staleAgeDays?: number;      // 預設 60
  staleAccessMin?: number;    // 預設 3
  staleImportanceMax?: number; // 預設 0.3
}): Promise<DreamResult> {
  
  // Phase 1: Orient — 收集所有記憶
  const memories = await memoryList({ scope, limit: 500 });
  const lastRun = await getLastDreamTimestamp();
  
  // Phase 2: Scan — 用程式碼精準偵測問題
  const duplicates = await detectDuplicates(memories, dedupThreshold);
  const timeIssues = detectRelativeTime(memories);
  const conflicts = await detectConflicts(memories);
  const staleItems = scoreAndFilterStale(memories, staleAgeDays, staleAccessMin, staleImportanceMax);
  
  // Phase 3: Consolidate — 精準修改
  if (!dryRun) {
    const changes = [...duplicates, ...timeIssues, ...conflicts, ...staleItems];
    const limited = changes.slice(0, maxChanges); // 上限保護
    await applyChanges(limited);
  }
  
  // Phase 4: Report
  return buildReport(duplicates, timeIssues, conflicts, staleItems);
}
```

---

## Analysis 模組

### 重複偵測（dedup-detector.ts）

```typescript
async function detectDuplicates(
  memories: Memory[],
  threshold: number = 0.90
): Promise<DedupPair[]> {
  const pairs: DedupPair[] = [];
  
  // 同 scope 內兩兩比對
  for (const scopeGroup of groupByScope(memories)) {
    for (let i = 0; i < scopeGroup.length; i++) {
      for (let j = i + 1; j < scopeGroup.length; j++) {
        const a = scopeGroup[i];
        const b = scopeGroup[j];
        
        const similarity = cosineSimilarity(a.embedding, b.embedding);
        const keywordOverlap = jaccardSimilarity(
          extractKeywords(a.text),
          extractKeywords(b.text)
        );
        const sameCategory = a.category === b.category;
        
        // 綜合判斷
        const isDuplicate = 
          (similarity >= threshold) ||
          (similarity >= 0.85 && keywordOverlap >= 0.7) ||
          (similarity >= 0.80 && sameCategory && keywordOverlap >= 0.6);
        
        if (isDuplicate) {
          pairs.push({
            a, b, similarity, keywordOverlap,
            keep: a.text.length >= b.text.length ? a : b,
            merge: a.text.length >= b.text.length ? b : a,
          });
        }
      }
    }
  }
  
  return pairs;
}
```

### 時間轉換（time-normalizer.ts）

```typescript
const RELATIVE_TIME_PATTERNS = [
  /(?:昨天|前天|上週|上個月|剛才|今天|這週|本週|本月)/,
  /(\d+)\s*(?:天|週|月|小時)前/,
  /(?:yesterday|last week|last month|today|this week)/i,
  /(\d+)\s*(?:days?|weeks?|months?|hours?)\s*ago/i,
  /(?:最近|近期|前陣子|earlier|recently)/,  // 模糊：只標記不轉
];

function detectRelativeTime(memories: Memory[]): TimeFixEntry[] {
  return memories
    .filter(m => RELATIVE_TIME_PATTERNS.some(p => p.test(m.text)))
    .map(m => ({
      memory: m,
      original: extractTimePhrase(m.text),
      resolved: resolveToAbsoluteDate(m.text, m.createdAt),
      newText: replaceTimePhrase(m.text, m.createdAt),
    }));
}
```

### 矛盾偵測（conflict-detector.ts）

```typescript
const CONTRADICTION_SIGNALS = [
  { affirm: /應該用\s*(\S+)/, negate: /不要用\s*(\S+)/ },
  { affirm: /已(?:經|)完成/, negate: /(?:尚未|還沒)完成/ },
  { affirm: /啟用/, negate: /停用|關閉/ },
  { pattern: /(\w+)\s*[:=：]\s*(\S+)/, type: "value-conflict" },
];

async function detectConflicts(memories: Memory[]): Promise<ConflictPair[]> {
  const conflicts: ConflictPair[] = [];
  
  for (const group of groupByScopeAndCategory(memories)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const similarity = cosineSimilarity(group[i].embedding, group[j].embedding);
        if (similarity >= 0.6 && similarity <= 0.85) {
          const contradiction = checkContradictionRules(group[i].text, group[j].text);
          if (contradiction) {
            conflicts.push({
              a: group[i], b: group[j],
              similarity,
              reason: contradiction.reason,
              action: "flag-for-review",  // 不自動解決
            });
          }
        }
      }
    }
  }
  
  return conflicts;
}
```

### 過時評分（staleness-scorer.ts）

```typescript
function scoreAndFilterStale(
  memories: Memory[],
  ageDays: number = 60,
  minAccess: number = 3,
  maxImportance: number = 0.3
): StaleEntry[] {
  const now = Date.now();
  
  return memories
    .map(m => {
      const age = (now - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      const staleness = 
        (Math.min(age / ageDays, 1) * 0.4) +
        (Math.max(1 - m.accessCount / minAccess, 0) * 0.3) +
        (Math.max(1 - m.importance, 0) * 0.3);
      
      return { memory: m, score: staleness, factors: { ageDays: age, accessCount: m.accessCount, importance: m.importance, decayTier: m.tier } };
    })
    .filter(s => s.score >= 0.7)
    .sort((a, b) => b.score - a.score);
}
```

---

## Config Schema

```json
{
  "id": "autodream",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "intervalHours": {
        "type": "number",
        "default": 24,
        "description": "兩次自動整理之間的最小間隔（小時）"
      },
      "scheduleHour": {
        "type": "number",
        "default": 3,
        "description": "每天幾點執行（0-23，本地時間）"
      },
      "minSessionsSinceLastRun": {
        "type": "number",
        "default": 3,
        "description": "距上次整理後至少要有幾個 session 才觸發"
      },
      "maxChangesPerRun": {
        "type": "number",
        "default": 20,
        "description": "每次最多處理幾條記憶變更"
      },
      "dedupThreshold": {
        "type": "number",
        "default": 0.90,
        "description": "重複偵測的向量相似度閾值"
      },
      "staleAgeDays": {
        "type": "number",
        "default": 60,
        "description": "超過幾天未存取算潛在過時"
      },
      "notifyTarget": {
        "type": "string",
        "description": "有問題時通知的 target（Discord channel/user ID）"
      },
      "autoMergeDuplicates": {
        "type": "boolean",
        "default": true,
        "description": "自動合併確認重複的記憶"
      },
      "autoFixTime": {
        "type": "boolean",
        "default": true,
        "description": "自動轉換相對時間為絕對時間"
      },
      "autoDeleteStale": {
        "type": "boolean",
        "default": false,
        "description": "自動刪除過時記憶（預設關閉，只標記）"
      }
    }
  }
}
```

---

## 安全護欄

| 規則 | 實作方式 |
|------|----------|
| **不自動刪除**（預設） | `autoDeleteStale: false`，只標記。需 Wayne 手動改 config 才開啟 |
| **每次上限 20 條** | `maxChangesPerRun` hard limit，超過的留到下次 |
| **高閾值開始** | dedup 預設 0.90（非常保守），確認穩定後再調低 |
| **dry-run 模式** | `dream_now` tool 支援 `dryRun: true`，只產報告 |
| **逐 scope 處理** | 不跨 scope 合併，避免 scope 隔離被打破 |
| **變更記錄** | 每次整理寫 report 到 `agents/admin/memory/autodream-{date}.md` |
| **通知機制** | 矛盾和需要人工判斷的項目才通知 Wayne |

---

## 現有架構盤點（供 kurisu 開發參考）

### Memory 系統

| 項目 | 現狀 |
|------|------|
| Plugin | memory-lancedb-pro v1.1.0-beta.8 |
| Embedding | text-embedding-3-small (OpenAI, 1536d) |
| Retrieval | hybrid (vector 0.7 + BM25 0.3) + Jina reranker |
| Smart Extraction | 啟用，gpt-4o-mini |
| Total Memories | 274 條（global 154 / business 92 / personal 28） |
| Scopes | global / business / personal + agent:* |
| Agent 數量 | 19 個 |
| Lifecycle | Weibull Decay，三層（Core/Working/Peripheral） |
| Dedup | 向量預篩 ≥ 0.7 + LLM 決策 |

### 與 memory-lancedb-pro 的關係

```
memory-lancedb-pro (existing)     autodream (new plugin)
┌─────────────────────┐           ┌─────────────────────────┐
│ autoCapture         │ ←session→ │                         │
│ autoRecall          │           │ dream-service (cron)    │
│ smartExtraction     │           │   ↓ reads via           │
│ memory_store        │ ←────────── memory_list             │
│ memory_recall       │ ←────────── memory_recall           │
│ memory_update       │ ←────────── memory_update (merge)   │
│ memory_forget       │ ←────────── memory_forget (if auto) │
│ Weibull Decay       │           │                         │
│ Dedup (0.7 LLM)    │           │ Dedup (0.9 rules-based) │
└─────────────────────┘           └─────────────────────────┘
```

**重點：** autoDream 不取代 memory-lancedb-pro 的 dedup，而是在更高閾值（0.9）做「第二層清掃」。

---

## 開發任務拆解

### Task 1：Plugin 骨架 + dream_now Tool

**優先級：P0** | **預估工時：3-4 小時**

1. 建立 plugin package（package.json, openclaw.plugin.json, index.ts）
2. 實作 `dream_now` tool（手動觸發 + dry-run）
3. 實作 `dream_status` tool
4. 基本的 dedup-detector（向量相似度比對）
5. 基本的 report 生成

**驗收標準：**
- `openclaw plugins list` 可以看到 autodream
- `/dream_now --dry-run` 可以產出報告
- 報告格式正確，列出疑似重複

### Task 2：完整 Analysis 模組

**優先級：P0** | **預估工時：4-5 小時**

1. time-normalizer（中英文相對時間偵測 + 轉換）
2. conflict-detector（規則式矛盾偵測）
3. staleness-scorer（多因子過時評分）
4. 單元測試

**驗收標準：**
- 中文相對時間（昨天、上週、3天前）正確轉換
- 矛盾偵測能抓到明顯對立（啟用 vs 停用）
- 過時評分合理（高 age + 低 access + 低 importance = 高分）

### Task 3：Background Service + 排程

**優先級：P1** | **預估工時：2-3 小時**

1. 實作 dream-service（registerService）
2. 定時排程邏輯（respecting intervalHours + scheduleHour）
3. 執行前檢查（minSessionsSinceLastRun）
4. 報告寫入 + 通知邏輯

**驗收標準：**
- 凌晨 3 點自動觸發（或可手動設定時間）
- 跳過條件正確（< 24h 或 session 不足）
- 報告自動寫入 memory/ 目錄
- 矛盾項目正確通知 Wayne

### Task 4：CLI 命令 + 文件

**優先級：P2** | **預估工時：1-2 小時**

1. `openclaw dream` CLI 命令
2. README.md / 使用文件
3. config 範例

---

## 部署計畫

### Phase 1：Dry-Run（第 1 週）
- 安裝 plugin，只開 dry-run
- 每天看報告，確認偵測準確度
- 調整閾值

### Phase 2：Auto-Merge Only（第 2 週）
- 開啟 `autoMergeDuplicates: true`
- 開啟 `autoFixTime: true`
- 矛盾和過時仍然只標記
- 持續監控

### Phase 3：Full Auto（第 3 週+）
- 根據前兩週經驗決定是否開啟 `autoDeleteStale`
- 調低 dedup threshold（從 0.90 → 0.85）

---

## 風險與注意事項

| 風險 | 緩解 |
|------|------|
| 誤合併不同記憶 | 閾值從 0.90 開始、dry-run 先跑一週 |
| 與 memory-lancedb-pro dedup 衝突 | autoDream 用更高閾值（0.9 vs 0.7），不同層級不衝突 |
| embedding 存取效能 | 用 memory_list 批次取，不逐條 recall |
| 時間轉換錯誤 | 只轉換明確的相對時間（昨天、3天前），模糊詞（最近、前陣子）只標記不轉 |
| 跨 scope 誤操作 | 逐 scope 獨立處理，程式碼強制 scope 隔離 |
| Plugin 啟動衝突 | 不佔用 memory slot，是獨立 plugin，與 memory-lancedb-pro 並存 |
| Cron job 之前的 bug（announce 洩漏） | 用 registerService 而非 cron，不走 agent session 的 delivery mode |

---

## 相關 Plugin

- **skillforge**（獨立 plugin）— Skill 自動偵測、生成、生命週期管理。見 `projects/skillforge-openclaw/spec.md`
