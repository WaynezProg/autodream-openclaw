# autoDream Plugin — Task 1: Plugin 骨架 + dream_now Tool

> 修正版 — 基於 SDK 實際驗證結果
> Assignee: kimi (via acpx)

---

## 目標

建立 autoDream OpenClaw Plugin 骨架，包含：
1. Plugin manifest + entry
2. `dream_now` tool（手動觸發 + dry-run）
3. `dream_status` tool
4. 基本的 dedup-detector（向量 cosine similarity）
5. 報告生成

---

## ⚠️ 關鍵修正（與原 spec.md 的差異）

### 修正 1：直接存取 LanceDB（不透過 memory tools）

**原 spec 寫：** 用 `memory_list()` / `memory_update()` / `memory_forget()` 等 tools
**實際情況：** Plugin SDK 沒有 `callTool` API，無法在 plugin 內呼叫 agent tools

**正確做法：** 直接用 `@lancedb/lancedb` npm 套件開啟 `~/.openclaw/memory/lancedb` 資料庫

```typescript
import * as lancedb from "@lancedb/lancedb";

// LanceDB 路徑
const DB_PATH = path.join(os.homedir(), ".openclaw", "memory", "lancedb");

async function openMemoryDb() {
  return await lancedb.connect(DB_PATH);
}

// Table 命名：每個 agent 有自己的 table
// 格式：memories_{agentId} 或 memories（需要探查實際 table name）
```

### 修正 2：Memory Entry 沒有 `accessCount` / `tier` 欄位

**實際 LanceDB schema 欄位：** `id`, `text`, `category`, `importance`, `scope`, `createdAt`, `embedding`/`vector`

**沒有的：** `accessCount`, `tier`, `updatedAt`, `lastAccessedAt`

**影響：** staleness-scorer 只能用 `ageDays` × `importance` 兩個因子。Task 1 先不做 staleness，留給 Task 2。

### 修正 3：`agent_end` hook event 型別

**實際型別：**
```typescript
// event
type PluginHookAgentEndEvent = {
  messages: unknown[];  // session messages array
  success: boolean;
  error?: string;
  durationMs?: number;
};

// context（第二參數）
type PluginHookAgentContext = {
  runId?: string;
  agentId?: string;      // ← agentId 在 ctx 裡
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;      // "user" | "heartbeat" | "cron" | "memory"
  channelId?: string;
};

// 正確的 handler signature
api.on("agent_end", async (event, ctx) => {
  const agentId = ctx.agentId;
  const messages = event.messages;
  // ...
});
```

### 修正 4：Hook 註冊用 `api.on` 而非 `api.registerHook`

```typescript
// ❌ spec 寫的
api.registerHook(["agent_end"], handler);

// ✅ 實際 type-safe API
api.on("agent_end", handler);
```

### 修正 5：`self_improvement_log` 不可直接呼叫

改成直接寫檔到 agent 的 memory/ 目錄：
```typescript
import fs from "node:fs/promises";

async function writeSkillSuggestion(workspaceDir: string, content: string) {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(workspaceDir, "memory", `autodream-${date}.md`);
  await fs.appendFile(filePath, `\n${content}\n`);
}
```

---

## Plugin SDK Reference

Plugin SDK 位置：`/Users/waynetu/.local/share/mise/installs/node/22.22.2/lib/node_modules/openclaw/dist/plugin-sdk`

核心 API（來自 `definePluginEntry` 的 `register(api)` 參數）：

```typescript
// 註冊 tool（給 agent 使用）
api.registerTool((ctx) => ({
  name: "dream_now",
  label: "Dream Now",
  description: "...",
  parameters: schema,
  execute: async (toolCallId, params) => { /* ... */ }
}), { names: ["dream_now"] });

// 註冊 hook
api.on("agent_end", async (event, ctx) => { /* ... */ });

// 註冊 background service
api.registerService({
  id: "autodream-scheduler",
  async start(serviceCtx) {
    // serviceCtx 有 config, stateDir, logger
  },
  async stop() { /* ... */ }
});

// 註冊 CLI
api.registerCli(({ program }) => {
  program.command("dream").description("...").action(async () => { /* ... */ });
}, { descriptors: [{ name: "dream", description: "..." }] });
```

---

## 目錄結構

```
/Users/waynetu/.openclaw/workspace/projects/autodream-openclaw/
├── package.json
├── tsconfig.json
├── openclaw.plugin.json
├── src/
│   ├── index.ts                 ← Plugin entry
│   ├── dream-engine.ts          ← 核心引擎（Task 1 只做 dedup）
│   ├── lancedb-adapter.ts       ← LanceDB 直接存取封裝
│   ├── tools/
│   │   ├── dream-trigger.ts     ← dream_now tool
│   │   └── dream-status.ts      ← dream_status tool
│   ├── analysis/
│   │   └── dedup-detector.ts    ← 向量相似度重複偵測
│   └── report/
│       └── reporter.ts          ← 報告生成
├── tests/
│   └── dedup-detector.test.ts
└── README.md
```

---

## 實作細節

### 1. package.json

```json
{
  "name": "openclaw-autodream",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@lancedb/lancedb": "^0.17.0",
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "peerDependencies": {
    "openclaw": ">=0.70.0"
  }
}
```

### 2. openclaw.plugin.json

```json
{
  "id": "autodream",
  "name": "autoDream — Memory Consolidation",
  "description": "自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間",
  "version": "0.1.0",
  "main": "dist/index.js",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "intervalHours": { "type": "number", "default": 24 },
      "scheduleHour": { "type": "number", "default": 3 },
      "maxChangesPerRun": { "type": "number", "default": 20 },
      "dedupThreshold": { "type": "number", "default": 0.90 },
      "staleAgeDays": { "type": "number", "default": 60 },
      "autoMergeDuplicates": { "type": "boolean", "default": false },
      "autoFixTime": { "type": "boolean", "default": false },
      "autoDeleteStale": { "type": "boolean", "default": false }
    }
  }
}
```

### 3. lancedb-adapter.ts — 關鍵模組

```typescript
// 封裝 LanceDB 直接存取
// 需要：
// 1. 探查 table 命名規則（啟動時 list tables）
// 2. 讀取所有記憶（含 vector/embedding column）
// 3. Schema 版本偵測 — 遇到不認識的 schema 就 graceful fail
// 4. 不做寫入操作（Task 1 是 dry-run only）

export interface MemoryRecord {
  id: string;
  text: string;
  category: string;
  importance: number;
  scope: string;
  createdAt: string;
  vector: number[];  // embedding vector
}

export async function listAllMemories(scope?: string): Promise<MemoryRecord[]> {
  // 開 LanceDB → list tables → 讀取 → 過濾 scope
}

export async function getTableSchema(): Promise<string[]> {
  // 回傳 column names，用於 schema 偵測
}
```

### 4. dedup-detector.ts

```typescript
export interface DedupPair {
  a: MemoryRecord;
  b: MemoryRecord;
  similarity: number;
  keywordOverlap: number;
  keep: MemoryRecord;   // 保留較完整的
  merge: MemoryRecord;  // 建議合併（刪除）的
}

// cosine similarity 用純 JS 算，不需要外部函式庫
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Jaccard similarity for keyword overlap
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}
```

### 5. dream_now tool 回傳格式

```typescript
// dry-run 時回傳 DreamReport
interface DreamReport {
  timestamp: string;
  scanned: number;
  duplicates: {
    count: number;
    pairs: Array<{
      a: { id: string; text: string; scope: string };
      b: { id: string; text: string; scope: string };
      similarity: number;
      action: "merge" | "flag";
    }>;
  };
  dryRun: boolean;
  nextModules: string[];  // "time-normalizer", "conflict-detector", "staleness-scorer" 待實作
}
```

---

## 驗收標準

1. ✅ `npm run build` 編譯通過（零 error）
2. ✅ Plugin 結構正確（openclaw.plugin.json + definePluginEntry）
3. ✅ `dream_now` tool 可被 agent 呼叫，支援 `scope` 和 `dryRun` 參數
4. ✅ `dream_status` tool 回傳上次執行時間和基本統計
5. ✅ dedup-detector 正確計算 cosine similarity + jaccard similarity
6. ✅ LanceDB adapter 能讀取 `~/.openclaw/memory/lancedb`，graceful fail 如果 schema 不認識
7. ✅ 報告格式清楚，列出疑似重複對和相似度分數
8. ✅ 單元測試覆蓋 cosine similarity 和 jaccard similarity
9. ✅ **不做任何寫入操作**（Task 1 是 read-only + dry-run）

---

## 注意事項

- LanceDB 的 table 命名規則需要在開發時探查（`db.tableNames()`）
- embedding column 可能叫 `vector` 或 `embedding`，兩種都要試
- 不要 import openclaw 內部模組（只用 plugin-sdk 的 public API）
- TypeScript strict mode
- 不要自己裝 openclaw 作為 dependency，用 peerDependencies
