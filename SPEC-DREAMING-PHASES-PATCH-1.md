# autoDream Dreaming Phases — Patch 1：Scope 修正

> **Version:** 1.1  
> **Date:** 2026-04-07  
> **Author:** 芙莉蓮（COO）  
> **Assignee:** Kurisu  
> **Status:** 待修正

---

## 背景

Task 1~4 已完成，build 通過，174 個測試全過。但 code review 發現 REM Reflection 的 scope 過濾有缺口。

Deep Promotion 的 scope gate 正確實作了（`PROMOTABLE_SCOPES` 過濾）。問題出在 **Recall Tracker 沒有記錄 scope，導致 REM Reflection 無法過濾**。

---

## 問題

### rem-reflector.ts 第 8-11 行

```typescript
// NOTE: Spec requires filtering recall logs to only global+business scope.
// v1 limitation: RecallLogEntry does not store per-hit scope, so we cannot
// filter here.
```

這意味著 DREAMS.md 的主題統計會包含所有 agent 的 recall 查詢模式，可能洩漏 agent-specific 的工作內容到共用檔案中。

---

## 修正內容

### 1. RecallHit 加入 scope 欄位

**檔案：** `src/tracking/recall-tracker.ts`

```typescript
// 修改前
export interface RecallHit {
  id: string;
  score: number;
}

// 修改後
export interface RecallHit {
  id: string;
  score: number;
  scope?: string;  // 新增：記憶的 scope（global, business, agent:xxx 等）
}
```

### 2. record 方法傳入 scope

hook 在記錄 recall event 時，需要從 memory_recall 的回傳結果中取得每筆 hit 的 scope。

**檔案：** `src/tracking/recall-tracker.ts`

```typescript
// recordFromToolResult — 修改 hits mapping
recordFromToolResult(
  toolResult: { result?: unknown },
  query: string,
  agentId?: string,
): RecallLogEntry | null {
  const payload = toolResult.result as
    | { memories?: Array<{ id: string; score?: number; scope?: string }> }
    | undefined;
  if (!payload?.memories?.length) return null;

  const hits: RecallHit[] = payload.memories.map((m) => ({
    id: m.id,
    score: m.score ?? 0,
    scope: m.scope,  // 新增
  }));

  return { ts: Date.now(), query, agentId, hits };
}

// recordFromMessage — 同樣修改
recordFromMessage(
  msg: { content?: unknown; toolName?: string },
  agentId?: string,
): RecallLogEntry | null {
  // ... 解析 parsed
  const hits: RecallHit[] = parsed.memories.map((m) => ({
    id: m.id,
    score: m.score ?? 0,
    scope: m.scope,  // 新增
  }));
  // ...
}
```

**注意：** `memory_recall` 回傳的 payload 是否包含 `scope` 欄位，取決於 `memory-lancedb-pro` plugin。需確認。如果不包含 scope，則需要在 record 時用 memory ID 反查 LanceDB 取得 scope（但這會增加延遲，不建議）。

**務實做法：** 如果 recall result 不包含 scope，改從 `RecallLogEntry` 層級加一個 `agentScope?: string`，記錄**觸發 recall 的 agent** 的 scope（從 `ctx.agentId` 推導）。雖然不是記憶本身的 scope，但至少可以過濾掉 agent-specific 的查詢來源。

### 3. REM Reflection 加入 scope 過濾

**檔案：** `src/analysis/rem-reflector.ts`

刪除第 8-11 行的 v1 limitation 註解，改為實作過濾：

```typescript
const REFLECTABLE_SCOPES = ["global", "business"];

// 在 runRemReflection 的入口處過濾 entries
// 方案 A：按 hit scope 過濾（如果 RecallHit 有 scope）
function filterByHitScope(entries: RecallLogEntry[]): RecallLogEntry[] {
  return entries
    .map(entry => ({
      ...entry,
      hits: entry.hits.filter(h => !h.scope || REFLECTABLE_SCOPES.includes(h.scope)),
    }))
    .filter(entry => entry.hits.length > 0);
}

// 方案 B：按 agentScope 過濾（fallback）
function filterByAgentScope(entries: RecallLogEntry[]): RecallLogEntry[] {
  return entries.filter(entry => {
    // 沒有 agentScope 資訊的 entry 保留（向後相容舊 log）
    if (!entry.agentScope) return true;
    return REFLECTABLE_SCOPES.includes(entry.agentScope);
  });
}
```

**選擇哪個方案取決於 Step 2 的結論**（memory_recall 回傳是否帶 scope）。

### 4. RecallStats 也加 scope 感知

**檔案：** `src/tracking/recall-tracker.ts`

`getStats()` 加入可選的 scope 過濾參數：

```typescript
export interface RecallStatsOptions {
  since?: number;
  minRecalls?: number;
  filterScopes?: string[];  // 新增：只統計這些 scope 的 hits
}

// 在 getStats 的迴圈中：
for (const hit of entry.hits) {
  // 如果指定了 filterScopes，跳過不符合的 hit
  if (options?.filterScopes && hit.scope && !options.filterScopes.includes(hit.scope)) {
    continue;
  }
  // ... 原有統計邏輯
}
```

### 5. 更新測試

**新增/修改測試：**

- `tests/recall-tracker.test.ts`
  - hit 帶 scope 時正確序列化/反序列化
  - `getStats({ filterScopes: ["global"] })` 正確過濾
  - 舊格式 log（無 scope）向後相容

- `tests/rem-reflector.test.ts`
  - entries 含 agent-specific hits 時被正確過濾
  - 過濾後 entries 不足 minWeeklyRecalls → 跳過（不產出 DREAMS.md）

---

## 向後相容

- `scope` 是 optional 欄位。已存在的 recall-log.jsonl 不需要遷移
- 沒有 scope 的舊 hit 預設通過過濾（不排除）
- 隨著新 log 累積，scope 覆蓋率會逐漸上升

---

## 不需要改的

- **deep-promoter.ts** — scope gate 已正確實作 ✅
- **dream-engine.ts** — 不需要改，Deep/REM 的 scope 過濾在各自模組內處理
- **dream-service.ts** — 不需要改
- **reporter.ts** — 不需要改

---

## 驗收標準

- [ ] `RecallHit` 有 `scope?: string` 欄位
- [ ] `recordFromToolResult` / `recordFromMessage` 會嘗試帶入 scope
- [ ] `getStats` 支援 `filterScopes` 參數
- [ ] `rem-reflector.ts` 在 `runRemReflection` 中過濾 entries
- [ ] 刪除 rem-reflector.ts 的 "v1 limitation" 註解
- [ ] 舊 log 向後相容（無 scope 的 hit 通過過濾）
- [ ] `npm run build` 無 error
- [ ] `npm run test` 全部通過（含新增測試）

---

## 優先級

**中等**。DREAMS.md 是趨勢摘要不是具體記憶，洩漏風險比 MEMORY.md 低。但既然 spec 明確寫了 scope 限制是硬性規則，應該補上。

先確認 `memory_recall` 回傳是否帶 scope，再決定用方案 A 或 B。
