# Memory Supersession Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `autodream` so it can detect and safely manage memories that are replaced by newer decisions or preferences, without deleting historical facts.

**Architecture:** Add a new supersession phase inside `autodream`, after conflict detection and before stale scoring. The phase produces dry-run proposals by default, then applies metadata-only invalidation when explicitly enabled. `memory-lancedb-pro` remains the owner of storage semantics; `autodream` only reads LanceDB rows and updates metadata fields that already exist or are added in a backward-compatible way.

**Tech Stack:** TypeScript, Vitest, LanceDB table updates, existing `autodream` phases, existing `MemoryRecord.metadata` JSON.

---

## Design Summary

This belongs in `autodream`, not the daily sync cron. Daily sync should keep importing durable notes; `autodream` should govern the memory graph afterward. The existing plugin already has `conflict-detector`, `staleness-scorer`, `dedup-merger`, reports, CLI, and dry-run behavior. Supersession is the missing semantic layer.

Do not hard-delete old memories for method or preference changes. Mark old memories as superseded, keep their original text, and make retrieval prefer a canonical current memory.

## Required Semantics

Memory lifecycle states:
- `confirmed`: current usable memory.
- `superseded`: historically true or previously preferred, but replaced by a newer memory.
- `obsolete_preference`: previous user preference that must not be recommended.
- `conflicting`: contradictory memory pair that needs manual review.

Metadata fields:
- `state`: one of the lifecycle states above.
- `valid_from`: epoch milliseconds when the memory became valid.
- `valid_until`: epoch milliseconds when the memory stopped being current.
- `supersedes`: memory id or ids this memory replaces.
- `superseded_by`: memory id that replaced this memory.
- `supersession_reason`: short reason such as `method_migration`, `preference_changed`, `config_drift`, `newer_decision`.
- `canonical_key`: stable topic key such as `model-policy:subagent`, `preference:browser-tool-routing`, `workflow:session-cleanup`.

Retrieval contract:
- `confirmed` memories remain normal.
- `superseded` memories remain searchable for history, but should be excluded or strongly downranked in autoRecall/recommendation.
- `obsolete_preference` memories must not be used for recommendation unless the user explicitly asks for history.
- `conflicting` memories should be reported, not auto-applied.

## File Map

- Modify: `src/lancedb-adapter.ts`
  Add metadata update helpers and typed supersession metadata.
- Create: `src/analysis/supersession-detector.ts`
  Detect method migrations, preference changes, config drift, and newer decision replacements.
- Create: `src/analysis/supersession-applier.ts`
  Apply metadata-only changes to old and new memories.
- Modify: `src/dream-engine.ts`
  Insert supersession phase and expose config flags.
- Modify: `src/report/reporter.ts`
  Add supersession proposal and apply result sections.
- Modify: `src/cli/dream-cli.ts`
  Add `--apply-supersession` and `--supersession-max <n>`.
- Test: `tests/supersession-detector.test.ts`
- Test: `tests/supersession-applier.test.ts`
- Test: `tests/dream-engine-supersession.test.ts`
- Test: `tests/reporter-supersession.test.ts`

## Task 1: Metadata Update API

**Files:**
- Modify: `src/lancedb-adapter.ts`
- Test: `tests/supersession-applier.test.ts`

- [ ] **Step 1: Write failing tests for metadata parsing and updates**

Add a test that creates two memories:

```ts
const oldMemory = makeMem("old-a", "之前使用 A 方法處理 session cleanup", {
  metadata: JSON.stringify({ state: "confirmed", canonical_key: "workflow:session-cleanup" }),
});
const newMemory = makeMem("new-b", "2026-07-06 起改用 B 方法處理 session cleanup", {
  metadata: JSON.stringify({ state: "confirmed", canonical_key: "workflow:session-cleanup" }),
});
```

Expected old metadata after apply:

```json
{
  "state": "superseded",
  "superseded_by": "new-b",
  "supersession_reason": "method_migration"
}
```

Expected new metadata after apply:

```json
{
  "state": "confirmed",
  "supersedes": ["old-a"]
}
```

- [ ] **Step 2: Add typed metadata fields**

Extend `ParsedMetadata` in `src/lancedb-adapter.ts`:

```ts
state?: "confirmed" | "superseded" | "obsolete_preference" | "conflicting";
valid_until?: number;
supersession_reason?: "method_migration" | "preference_changed" | "config_drift" | "newer_decision";
canonical_key?: string;
supersedes?: string | string[];
superseded_by?: string;
```

- [ ] **Step 3: Add metadata-only update helper**

Add:

```ts
async updateMemoryMetadata(id: string, metadata: ParsedMetadata): Promise<boolean>
```

It must read the existing row, merge JSON metadata, and update only `metadata`. It must not mutate `text`, `vector`, `timestamp`, or `importance`.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/supersession-applier.test.ts
```

Expected: the new test fails before implementation, then passes after metadata helper is added.

## Task 2: Supersession Detector

**Files:**
- Create: `src/analysis/supersession-detector.ts`
- Test: `tests/supersession-detector.test.ts`

- [ ] **Step 1: Define proposal types**

Create:

```ts
export interface SupersessionProposal {
  old: MemoryRecord;
  current: MemoryRecord;
  canonicalKey: string;
  reason: "method_migration" | "preference_changed" | "config_drift" | "newer_decision";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  action: "mark_superseded" | "mark_obsolete_preference" | "flag_conflict";
}
```

- [ ] **Step 2: Detect explicit method migrations**

Rules:
- Same `scope`.
- Same `category` in `decision`, `fact`, or `preference`.
- Same `canonical_key`, or LLM/rule-derived same topic.
- Newer memory contains patterns like `改用`, `起改`, `從 A 改為 B`, `不再使用`, `superseded`, `deprecated`.
- Older memory mentions the replaced method.

Required test:

```ts
expect(proposals[0].reason).toBe("method_migration");
expect(proposals[0].action).toBe("mark_superseded");
expect(proposals[0].old.id).toBe("method-a");
expect(proposals[0].current.id).toBe("method-b");
```

- [ ] **Step 3: Detect preference changes**

Rules:
- `category === "preference"`.
- Newer memory says `現在偏好`, `改成`, `不要推薦`, `不喜歡`, `prefer C over B`.
- Older memory has same preference topic and different value.
- Old action is `mark_obsolete_preference`, not plain `mark_superseded`.

Required test:

```ts
expect(proposals[0].reason).toBe("preference_changed");
expect(proposals[0].action).toBe("mark_obsolete_preference");
```

- [ ] **Step 4: Detect config drift**

Rules:
- Same canonical key or same key/value namespace.
- Newer memory has concrete config value that differs from older memory.
- Examples: `model=qwen/qwen3.7-plus` replaces `model=qwen/qwen3.6-plus`; `heartbeat.enabled=false` replaces `heartbeat.enabled=true`.

Required test:

```ts
expect(proposals[0].reason).toBe("config_drift");
expect(proposals[0].canonicalKey).toBe("config:cron-model:lancedb-daily-sync");
```

## Task 3: Canonical Key Extraction

**Files:**
- Create: `src/analysis/canonical-key.ts`
- Test: `tests/canonical-key.test.ts`
- Modify: `src/analysis/supersession-detector.ts`

- [ ] **Step 1: Implement deterministic key extraction**

Implement:

```ts
export function deriveCanonicalKey(memory: MemoryRecord): string | null
```

Priority:
1. Existing `metadata.canonical_key`.
2. Config pattern: `name`, `id`, `model`, `scope`, `database_id`, `data_source_id`.
3. Preference pattern: `喜歡`, `偏好`, `推薦`, `不要推薦`.
4. Workflow pattern: `workflow`, `流程`, `SOP`, `cron`, `cleanup`, `session2memory`.

- [ ] **Step 2: Avoid over-grouping**

Keys must include scope-like context. `model` alone is invalid. Good keys:
- `config:cron-model:lancedb-daily-sync`
- `preference:browser-tool-routing`
- `workflow:session-cleanup`

Bad keys:
- `model`
- `preference`
- `cron`

## Task 4: Supersession Applier

**Files:**
- Create: `src/analysis/supersession-applier.ts`
- Modify: `src/lancedb-adapter.ts`
- Test: `tests/supersession-applier.test.ts`

- [ ] **Step 1: Apply metadata-only changes**

Implement:

```ts
export async function applySupersessionProposals(
  adapter: Pick<LanceDbAdapter, "updateMemoryMetadata">,
  proposals: SupersessionProposal[],
  opts: { maxChanges: number; now?: number },
): Promise<SupersessionApplyResult>
```

Behavior:
- Apply only `high` confidence proposals.
- Limit to `maxChanges`.
- Set `valid_until` on old memory.
- Set `superseded_by` on old memory.
- Add old id to `current.supersedes`.
- Never delete rows.
- Never apply `flag_conflict`; report only.

- [ ] **Step 2: Protect core memories**

Skip apply if old metadata has `tier: "core"` unless proposal reason is `preference_changed` and the newer memory has `importance >= old.importance`.

## Task 5: Dream Engine Integration

**Files:**
- Modify: `src/dream-engine.ts`
- Test: `tests/dream-engine-supersession.test.ts`

- [ ] **Step 1: Extend config**

Add:

```ts
supersessionEnabled: boolean;
supersessionApply: boolean;
supersessionMaxChangesPerRun: number;
```

Defaults:

```ts
supersessionEnabled: true;
supersessionApply: false;
supersessionMaxChangesPerRun: 10;
```

- [ ] **Step 2: Insert phase**

Order:
1. Noise detection.
2. Dedup detection.
3. Conflict detection.
4. Supersession detection.
5. Time issues.
6. Stale scoring.
7. Optional applies.

Rationale: supersession must see conflicts but must run before stale scoring so obsolete preferences are not treated as generic stale garbage.

- [ ] **Step 3: Keep dry-run default**

`runDream()` must not apply supersession unless both are true:

```ts
!dryRun && config.supersessionApply
```

## Task 6: Reporting and CLI

**Files:**
- Modify: `src/report/reporter.ts`
- Modify: `src/cli/dream-cli.ts`
- Test: `tests/reporter-supersession.test.ts`

- [ ] **Step 1: Add report section**

Markdown section:

```md
## Supersession Proposals (N)
- [high] method_migration workflow:session-cleanup
  - old: `old-a` — previously used A
  - current: `new-b` — now use B
  - action: mark_superseded
```

- [ ] **Step 2: Add CLI switches**

Add:

```bash
openclaw dream --scope global --dry-run
openclaw dream --scope global --no-dry-run --apply-supersession --supersession-max 10
```

`--no-dry-run` alone must not apply supersession unless `--apply-supersession` is also present.

## Task 7: Retrieval Suppression Contract

**Files:**
- Modify in `memory-lancedb-pro`: retrieval filter path after confirming exact file with search.
- Test in `memory-lancedb-pro`: add retrieval regression test.

- [ ] **Step 1: Filter or downrank superseded memories**

AutoRecall should exclude:

```ts
state === "obsolete_preference"
```

AutoRecall should downrank:

```ts
state === "superseded"
```

Manual search may still include them if the query contains history intent such as `以前`, `歷史`, `舊方法`, `previous`, `deprecated`.

- [ ] **Step 2: Add regression test**

Given:
- old preference: `User prefers B`, metadata state `obsolete_preference`.
- new preference: `User now prefers C`, metadata state `confirmed`.

Query:

```ts
"what should I recommend to Wayne?"
```

Expected: C appears, B does not appear.

Query:

```ts
"Wayne 以前偏好什麼?"
```

Expected: both C and historical B can appear, with B labeled historical.

## Task 8: Operational Rollout

**Files:**
- Modify: OpenClaw autodream cron config only after dry-run report is clean.
- Create: report under `~/.openclaw/tmp/data/YYYY-MM-DD/memory-supersession/`

- [ ] **Step 1: Run dry-run against current DB**

Run:

```bash
cd /Users/waynetu/.openclaw/plugins/autodream
npm test
npm run build
openclaw dream --scope global --dry-run > ~/.openclaw/tmp/data/2026-07-06/memory-supersession/dry-run.md
```

- [ ] **Step 2: Review first 20 proposals manually**

Approval criteria:
- Same topic.
- New memory clearly newer.
- New memory clearly replaces old behavior or preference.
- Old memory should still be useful as history.

- [ ] **Step 3: Apply bounded batch**

Run:

```bash
openclaw dream --scope global --no-dry-run --apply-supersession --supersession-max 10
```

- [ ] **Step 4: Verify recall behavior**

Run targeted recall queries:

```bash
openclaw memory-pro search "Wayne 現在偏好" --json
openclaw memory-pro search "OpenClaw 目前模型策略" --json
openclaw memory-pro search "以前使用的方法" --json
```

Expected:
- Current preference and current method rank above historical entries.
- Historical entries still exist and are discoverable with history intent.
- No memory rows are hard-deleted by supersession.

## Non-Goals

- Do not rewrite every old memory text.
- Do not automatically delete old memories.
- Do not let LLM alone decide destructive changes.
- Do not mix business scope cleanup into main/global unless the memory already belongs to accessible scopes.
- Do not make daily `lancedb-daily-sync` responsible for semantic governance.

## Acceptance Criteria

- `autodream` reports supersession proposals in dry-run.
- Applying supersession changes only metadata fields.
- `obsolete_preference` is not recommended by autoRecall.
- Historical queries can still retrieve superseded memories.
- First live apply is capped at 10 changes.
- Full test suite passes in `autodream`; retrieval regression passes in `memory-lancedb-pro`.
