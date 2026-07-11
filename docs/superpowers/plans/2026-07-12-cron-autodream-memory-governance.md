# Cron + autoDream Memory Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and safely activate one cron-driven, shadow-first memory-governance pipeline that preserves history, excludes inactive memories from normal recall, and never deletes on age alone.

**Architecture:** `memory-lancedb-pro` defines and enforces the lifecycle contract and retrieval modes. `autodream` analyzes candidates, performs bounded verified mutations, and emits run manifests; OpenClaw cron is the only scheduler. The first live rollout is dry-run shadow mode, so semantic writes remain disabled until seven successful daily observations and manual proposal review.

**Tech Stack:** TypeScript, Vitest, Node test runner, LanceDB, OpenClaw plugin SDK/CLI, OpenClaw cron.

## Global Constraints

- Stale age is review-only; it cannot hard-delete a memory.
- Normal recall returns only active `confirmed` memories.
- `tier=core` blocks automatic lifecycle transitions.
- `supersedes` is always a string array; `invalidated_at` represents supersession while `valid_until` represents natural expiry.
- Duplicate mutation requires same scope and category, a working embedder, vector-dimension validation, write/read-back verification, then deletion.
- The live rollout starts with seven days of dry-run shadow mode and no semantic mutation.
- Existing unrelated dirty-worktree changes must remain intact and must not be reverted.

---

## File Structure

- `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/src/smart-metadata.ts`: canonical lifecycle types, normalization, active/history predicates, array relationship serialization.
- `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/src/store.ts`: lifecycle-aware list/search candidate filtering.
- `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/src/tools.ts`: explicit `active`, `history`, and `review` recall behavior and lifecycle labels.
- `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/test/governance-lifecycle-contract.test.mjs`: contract and retrieval regression tests.
- `/Users/waynetu/.openclaw/plugins/autodream/src/analysis/supersession-detector.ts`: bounded same-topic proposal generation and confidence.
- `/Users/waynetu/.openclaw/plugins/autodream/src/analysis/supersession-applier.ts`: chain reduction, core protection, metadata mutation and rollback payloads.
- `/Users/waynetu/.openclaw/plugins/autodream/src/analysis/verified-merge.ts`: same-scope/category transactional duplicate merge.
- `/Users/waynetu/.openclaw/plugins/autodream/src/governance/governance-runner.ts`: lock, preflight, runId, manifests, benchmarks, fail-closed orchestration.
- `/Users/waynetu/.openclaw/plugins/autodream/src/governance/run-manifest.ts`: versioned manifest/status schema and atomic JSON writes.
- `/Users/waynetu/.openclaw/plugins/autodream/src/cli/dream-cli.ts`: deterministic governance CLI and non-zero failures.
- `/Users/waynetu/.openclaw/plugins/autodream/src/dream-service.ts`: `schedulerEnabled` cutover and no internal timer in cron mode.
- `/Users/waynetu/.openclaw/plugins/autodream/openclaw.plugin.json`: schema for scheduler, governance and shadow rollout settings.
- `/Users/waynetu/.openclaw/openclaw.json`: disable internal scheduler and destructive automatic flags.
- OpenClaw cron jobs: reduce ingestion to import/backup/stats, disable standalone safe-improve, create `memory-governance-daily` at 08:20.

### Task 1: Canonical Lifecycle Contract and Retrieval Modes

**Files:**
- Modify: `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/src/smart-metadata.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/src/store.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/src/tools.ts`
- Create: `/Users/waynetu/.openclaw/plugins/memory-lancedb-pro/test/governance-lifecycle-contract.test.mjs`

**Interfaces:**
- Produces: `MemoryState`, `MemoryRecallMode`, `normalizeSupersedes()`, `isMemoryVisibleInMode()`.
- Consumes: existing `parseSmartMetadata()`, `buildSmartMetadata()`, `Retriever.retrieve()`.

- [ ] **Step 1: Write failing contract tests**

```js
assert.deepEqual(parseSmartMetadata(JSON.stringify({
  state: "superseded",
  supersedes: ["old-a", "old-b"],
  superseded_by: "new-c",
  canonical_key: "workflow:session-cleanup",
  supersession_reason: "method_migration",
}), entry).supersedes, ["old-a", "old-b"]);

assert.equal(isMemoryVisibleInMode(meta("confirmed"), "active", now), true);
assert.equal(isMemoryVisibleInMode(meta("superseded"), "active", now), false);
assert.equal(isMemoryVisibleInMode(meta("archived"), "history", now), true);
assert.equal(isMemoryVisibleInMode(meta("conflicting"), "history", now), false);
assert.equal(isMemoryVisibleInMode(meta("conflicting"), "review", now), true);
```

- [ ] **Step 2: Verify the tests fail on the current normalizer**

Run: `mise exec node@22 -- node --test test/governance-lifecycle-contract.test.mjs`

Expected: FAIL because non-legacy states normalize to `confirmed` and arrays are discarded.

- [ ] **Step 3: Implement the exact shared schema**

```ts
export type MemoryState =
  | "pending" | "confirmed" | "superseded"
  | "obsolete_preference" | "conflicting" | "archived";
export type MemoryRecallMode = "active" | "history" | "review";
export type SupersessionReason =
  | "method_migration" | "preference_changed"
  | "config_drift" | "newer_decision";

export function normalizeSupersedes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(values.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0,
  ).map((item) => item.trim()))];
}
```

Preserve `canonical_key`, `supersession_reason`, `invalidated_at`, `valid_until`, `superseded_by`, and array `supersedes` in both parse and patch paths.

- [ ] **Step 4: Filter before final top-N and expose explicit modes**

Add `mode` to `memory_recall` with default `active`. Filter retrieved candidates using:

```ts
export function isMemoryVisibleInMode(meta: SmartMemoryMetadata, mode: MemoryRecallMode, at: number): boolean {
  const active = isMemoryActiveAt(meta, at) && !isMemoryExpired(meta, at);
  if (mode === "active") return active && meta.state === "confirmed";
  if (mode === "history") return ["superseded", "obsolete_preference", "archived"].includes(meta.state);
  return ["pending", "conflicting"].includes(meta.state);
}
```

Over-fetch candidates, apply the mode predicate, then slice to the requested limit. Render `[state:<value>]` for non-active modes. Do not increment `last_confirmed_use_at` for history/review queries.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
mise exec node@22 -- node --test test/governance-lifecycle-contract.test.mjs test/governance-metadata.test.mjs test/memory-update-supersede.test.mjs test/smart-memory-lifecycle.mjs
mise exec node@22 -- npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit only Task 1 files**

```bash
git add src/smart-metadata.ts src/store.ts src/tools.ts test/governance-lifecycle-contract.test.mjs
git commit -m "fix: enforce memory lifecycle retrieval contract"
```

### Task 2: Safe Supersession and Duplicate Mutation

**Files:**
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/lancedb-adapter.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/analysis/supersession-detector.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/analysis/supersession-applier.ts`
- Create: `/Users/waynetu/.openclaw/plugins/autodream/src/analysis/verified-merge.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/dream-engine.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/tests/supersession-detector.test.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/tests/supersession-applier.test.ts`
- Create: `/Users/waynetu/.openclaw/plugins/autodream/tests/verified-merge.test.ts`

**Interfaces:**
- Consumes: Task 1 lifecycle JSON contract.
- Produces: `reduceSupersessionChains()`, `applySupersessionProposals()`, `applyVerifiedMerge()`.

- [ ] **Step 1: Add failing safety tests**

```ts
expect(detectSupersessionProposals([globalOld, agentNew])).toEqual([]);
expect(detectSupersessionProposals([factOld, preferenceNew])).toEqual([]);
expect(proposalWithOneSignal.confidence).toBe("medium");
expect(reduceSupersessionChains([v1, v2, v3])).toMatchObject([{ old: v1, current: v3 }]);
expect(adapter.deleteMemory).not.toHaveBeenCalled();
```

The merge test must cover embed failure, wrong vector dimension, update false, and read-back mismatch; every case expects zero deletes.

- [ ] **Step 2: Verify tests fail**

Run: `mise exec node@22 -- npm test -- tests/supersession-detector.test.ts tests/supersession-applier.test.ts tests/verified-merge.test.ts`

Expected: FAIL on hardcoded high confidence, category mismatch acceptance, pairwise chains, and unsafe merge deletion.

- [ ] **Step 3: Fix detection and chain reduction**

Require identical scope, compatible identical category, identical canonical key, and explicit replacement evidence. Score confidence deterministically:

```ts
const confidence: SupersessionConfidence =
  evidence.length >= 3 ? "high" : evidence.length === 2 ? "medium" : "low";
```

Group proposals by `scope/category/canonicalKey`, choose the newest confirmed node as current, reject cycles and conflicting latest timestamps, and emit at most one transition per old node.

- [ ] **Step 4: Make metadata apply reversible and core-safe**

Use `invalidated_at`, never `valid_until`, for supersession. Capture both rows before mutation and return rollback patches. If either row update or read-back fails, restore both rows and report an error. Skip every core mutation without exception.

- [ ] **Step 5: Implement verified duplicate merge**

```ts
export async function applyVerifiedMerge(args: {
  adapter: VerifiedMergeAdapter;
  merge: MergeResult;
  sourcePair: DuplicatePair;
  embedder: Embedder;
}): Promise<VerifiedMergeResult>
```

Reject different scope/category, require an embedder, verify vector length equals the kept row vector length, update text+vector, read back exact text/vector length, and only then delete `originalsToDelete`. Restore the kept row if verification or deletion fails.

- [ ] **Step 6: Remove destructive stale/noise behavior from daily apply**

Delete no stale memory. Change deterministic noise handling to proposals containing `quarantine_started_at`; do not hard-delete until a future run confirms seven elapsed days, unchanged content hash, no recent confirmed use, and no relationship references. Shadow mode only reports these proposals.

- [ ] **Step 7: Run focused and full tests, then commit Task 2 files**

Run:

```bash
mise exec node@22 -- npm test -- tests/supersession-detector.test.ts tests/supersession-applier.test.ts tests/verified-merge.test.ts tests/dream-engine-reembed.test.ts tests/dream-engine-supersession.test.ts
mise exec node@22 -- npm test
mise exec node@22 -- npx tsc --noEmit
```

Expected: all Vitest files and TypeScript checks pass.

### Task 3: Deterministic Governance Runner and Fail-Closed CLI

**Files:**
- Create: `/Users/waynetu/.openclaw/plugins/autodream/src/governance/run-manifest.ts`
- Create: `/Users/waynetu/.openclaw/plugins/autodream/src/governance/governance-runner.ts`
- Create: `/Users/waynetu/.openclaw/plugins/autodream/tests/governance-runner.test.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/cli/dream-cli.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/run-status.ts`

**Interfaces:**
- Consumes: `runDream()` plus reversible mutation results from Task 2.
- Produces: `runGovernance()`, manifest schema version `1`, CLI flags `--governance`, `--trigger`, `--shadow`.

- [ ] **Step 1: Write failing lock, status, idempotency, and failure-exit tests**

```ts
await expect(runGovernance({ lockPath, ...deps })).resolves.toMatchObject({ status: "success" });
await expect(runGovernance({ lockPath, ...deps })).resolves.toMatchObject({ status: "locked" });
expect(secondRun.applied).toBe(0);
expect(status.lastAttempt.runId).toBe(runId);
expect(status.lastSuccess.runId).toBe(runId);
```

Also simulate missing embedder, schema mismatch, mutation error, benchmark regression, and rollback failure; mutation must remain zero in preflight failures and CLI exit code must be non-zero for run/rollback failure.

- [ ] **Step 2: Implement atomic manifests and lock lifecycle**

Write JSON to a sibling temporary file, `fsync`, then rename. Manifest fields are `schemaVersion`, `runId`, trigger, config fingerprint, timestamps, phase counts, proposals, actions, skips, failures, benchmark delta, rollback result, and artifact paths. The lock contains pid/runId/start time and is stale only after the configured timeout and a dead pid check.

- [ ] **Step 3: Implement preflight and shadow execution**

Preflight validates config, lifecycle fields, DB read/write capability, model availability, and embedder availability. `shadow=true` runs analysis and benchmarks but passes `dryRun=true`, writes no semantic row, and still records success/failure status.

- [ ] **Step 4: Implement rollback and benchmark gates**

On any mutation/read-back error or negative fixed-query benchmark delta, apply rollback payloads in reverse action order. A rollback failure sets `status="rollback_failed"`, returns non-zero, and preserves the lock/manifest evidence for the watchdog.

- [ ] **Step 5: Wire the CLI**

```ts
.option("--governance", "Run deterministic governance pipeline", false)
.option("--shadow", "Analyze and benchmark without semantic mutation", false)
.option("--trigger <trigger>", "Manifest trigger label", "manual")
```

`--governance` calls `runGovernance`; ordinary `openclaw dream` keeps its existing report behavior. Any failed governance status sets `process.exitCode = 1`.

- [ ] **Step 6: Run tests and commit Task 3 files**

Run:

```bash
mise exec node@22 -- npm test -- tests/governance-runner.test.ts tests/dream-cli.test.ts
mise exec node@22 -- npm test
mise exec node@22 -- npm run build
```

Expected: all tests and build pass; `dist/index.js` includes the governance command.

### Task 4: Scheduler Cutover and Live Shadow Cron

**Files:**
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/dream-service.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/src/index.ts`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/openclaw.plugin.json`
- Modify: `/Users/waynetu/.openclaw/plugins/autodream/tests/dream-service.test.ts`
- Modify: `/Users/waynetu/.openclaw/openclaw.json`
- Update via CLI: OpenClaw cron jobs `lancedb-daily-sync`, `memory-quality-nightly-safe-improve`, `memory-governance-daily`.

**Interfaces:**
- Consumes: `openclaw dream --governance --shadow --trigger cron`.
- Produces: exactly one enabled semantic governance scheduler.

- [ ] **Step 1: Add failing scheduler-disable test**

```ts
const { service, internals } = createDreamServiceWithInternals(api({ schedulerEnabled: false }));
await service.start(ctx);
expect(internals.isScheduled()).toBe(false);
expect(writeNextRun).not.toHaveBeenCalled();
```

- [ ] **Step 2: Implement `schedulerEnabled`**

Default it to `true` for compatibility. When false, service start logs cron ownership and returns without catch-up, persisted schedule writes, or timers. Add the boolean to config schema.

- [ ] **Step 3: Build and validate plugin/config**

Run:

```bash
mise exec node@22 -- npm test -- tests/dream-service.test.ts
mise exec node@22 -- npm run build
openclaw config validate --json
```

Expected: tests/build pass and config validation returns valid JSON.

- [ ] **Step 4: Apply safe live config**

Set `schedulerEnabled=false`, `autoMergeDuplicates=false`, `autoFixTime=false`, `autoDeleteStale=false`, and `supersessionApply=false`. Preserve all secrets and unrelated config keys. Re-run `openclaw config validate --json` before restart.

- [ ] **Step 5: Cut over cron**

Update `lancedb-daily-sync` to import/backup/stats only at 07:50 and remove `memory_forget`, dedup, obsolete-decision, and Monday hard-delete instructions. Disable `memory-quality-nightly-safe-improve`. Create or update `memory-governance-daily` at `20 8 * * *` Asia/Taipei with a deterministic command payload that runs:

```bash
openclaw dream --governance --shadow --trigger cron
```

- [ ] **Step 6: Restart and live smoke**

Run:

```bash
openclaw gateway restart
openclaw health --json
openclaw plugins info autodream
openclaw cron list --all --json
openclaw dream --governance --shadow --trigger smoke
```

Expected: health is OK, both plugins load without error, exactly one semantic-governance cron is enabled, internal scheduler is disabled, shadow run exits 0 and writes manifest/status with zero semantic mutations.

### Task 5: Review, Final Verification, Commit, and Push

**Files:**
- Review all changed files in both plugin repos and `/Users/waynetu/.openclaw/openclaw.json`.

**Interfaces:**
- Produces: review findings resolved, green verification evidence, pushed commits on the configured fork remotes.

- [ ] **Step 1: Review intent and dirty-worktree scope**

Compare diffs against the approved spec and `decision_log.md`. Verify no unrelated dirty file was staged, no secret appears in diff, and no hard-delete path can be reached from shadow cron.

- [ ] **Step 2: Run complete verification**

Run:

```bash
cd /Users/waynetu/.openclaw/plugins/autodream && mise exec node@22 -- npm test && mise exec node@22 -- npx tsc --noEmit && mise exec node@22 -- npm run build
cd /Users/waynetu/.openclaw/plugins/memory-lancedb-pro && mise exec node@22 -- npm test
cd /Users/waynetu/.openclaw && openclaw config validate --json && openclaw health --json && openclaw cron list --all --json
```

Expected: zero test/type/build/config failures, healthy gateway, and the cron contract matches Task 4.

- [ ] **Step 3: Commit repo-local changes with exact path staging**

Commit autodream code/docs in `WaynezProg/autodream-openclaw`. Commit memory-lancedb-pro lifecycle code to its local branch and push to remote `fork`, never upstream `origin`. Do not commit `/Users/waynetu/.openclaw/openclaw.json` because it is machine-local runtime config.

- [ ] **Step 4: Push only after fresh post-commit verification**

```bash
git -C /Users/waynetu/.openclaw/plugins/autodream push origin main
git -C /Users/waynetu/.openclaw/plugins/memory-lancedb-pro push fork main
```

Expected: both pushes succeed and remote heads equal local `HEAD`.

- [ ] **Step 5: Record rollout boundary**

Report that code and shadow cron are active, but metadata apply remains intentionally disabled until seven consecutive successful runs and manual review of the first 20 proposals. This is an acceptance constraint, not unfinished implementation.
