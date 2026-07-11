# Cron + autoDream Memory Governance Design

**Date:** 2026-07-12
**Status:** Approved design

## Goal

Build one reliable memory-governance pipeline that periodically ingests durable notes, removes verified duplicates, suppresses superseded or contradictory memories from normal recall, and archives low-value stale memories without destroying useful history.

## Safety Boundary

- Stale does not mean obsolete. Age or low recall alone must never trigger hard deletion.
- Superseded memories remain stored as history but are excluded from normal autoRecall.
- Hard deletion is limited to deterministic noise and verified duplicate originals after a successful transactional merge, re-embedding, and read-back verification.
- `tier=core` memories are protected from automatic lifecycle changes.

## Current Problems

- No OpenClaw cron job actually invokes autoDream. Existing jobs only mention autoDream in prompt text.
- The autoDream internal scheduler can miss runs after gateway restarts because its session counter is in memory.
- `lancedb-daily-sync` both assumes autoDream owns deduplication and independently hard-deletes memories.
- `memory-quality-nightly-safe-improve` imports curated cards with `supersedes[]` but does not invalidate the original memory.
- autoDream and memory-lancedb-pro disagree on lifecycle states and the type of `supersedes`.
- Duplicate merging can cross scopes and can delete originals after an unsuccessful update.
- `autoDeleteStale` does not implement stale deletion; this currently prevents unsafe mass deletion.

## Ownership

### OpenClaw Cron

Cron owns reliable triggering, ordering, timeouts, and failure delivery. It does not decide whether a memory is obsolete or duplicate.

### autoDream

autoDream is the sole semantic-governance engine. It produces proposals, assigns confidence, applies bounded lifecycle transitions, merges verified duplicates, emits manifests, and requests rollback when verification fails.

### memory-lancedb-pro

memory-lancedb-pro owns the lifecycle schema, atomic storage operations, active/history retrieval modes, metadata preservation, and retrieval filtering.

### Auxiliary Jobs

Daily-note ingestion, HKS generation, storage retention, and database health checks remain separate. They must not perform semantic deduplication or delete semantic memory rows.

## Schedule and Data Flow

### 07:50 - Ingestion

`lancedb-daily-sync` performs only:

- import of current and previous daily notes through `memory_store`;
- lightweight JSON backup;
- memory count and scope statistics;
- anomaly reporting.

It must not call `memory_forget`, perform duplicate deletion, or decide that an old decision is obsolete.

### 08:20 - Daily Governance

A deterministic `memory-governance-daily` command runs under a single cross-process lock:

1. Validate configuration, lifecycle schema, database health, and available embedder.
2. Capture a rollback-safe pre-run snapshot and assign a unique `runId`.
3. Generate curated-memory candidates without importing them independently.
4. Run autoDream analysis for duplicate, conflict, supersession, noise, time, and stale candidates.
5. Apply only approved high-confidence lifecycle transitions and verified duplicate merges within configured caps.
6. Run fixed active-recall, history-recall, and targeted-recall benchmarks.
7. Roll back only the current run if mutation or benchmark verification fails.
8. Write status, action manifest, rollback manifest, and a compact report.

On Monday, the same pipeline additionally emits medium/low-confidence conflict and stale-archive review queues. It does not hard-delete them.

### After 09:15 - Storage Retention

Filesystem retention and database storage-health jobs run after semantic governance. They manage snapshots, logs, caches, sessions, and storage telemetry, not semantic memory lifecycle.

## Scheduler Cutover

- Add an explicit `schedulerEnabled` option to autoDream.
- Disable the autoDream internal timer when the cron-driven governance command is active.
- Disable the standalone `memory-quality-nightly-safe-improve` cron after its candidate-generation logic is integrated into the governance pipeline.
- Keep exactly one semantic-governance writer active at a time.

## Lifecycle Contract

The shared metadata schema is:

- `state`: `confirmed | superseded | obsolete_preference | conflicting | archived`
- `valid_from`: epoch milliseconds
- `invalidated_at`: epoch milliseconds used for supersession inactivity
- `valid_until`: optional natural expiry, distinct from supersession
- `supersedes`: string array
- `superseded_by`: string
- `supersession_reason`: `method_migration | preference_changed | config_drift | newer_decision`
- `canonical_key`: stable topic identifier
- `tier`: includes protected `core`

Both plugins must parse, preserve, serialize, and test this exact contract.

## Automated Decisions

### Supersession

- Compare only memories in the same scope, compatible category, and canonical topic.
- Resolve a multi-version chain to one current memory rather than applying every pair.
- Apply only high-confidence proposals with explicit replacement evidence.
- Apply at most 10 lifecycle transitions per daily run.
- Medium, low, and conflicting proposals go to review.
- Never automatically mutate a core memory.

### Duplicate Merge

- Require the same scope and category.
- Require vector similarity plus lexical or structured-topic agreement.
- Generate merged text, embed it, and validate vector dimensions before storage mutation.
- Atomically write and read back the merged record before deleting originals.
- If any step fails, delete nothing and mark the proposal failed.

### Stale Archive

- Staleness is only a review signal.
- A weekly archive candidate must be non-core, low importance, inactive, not part of a live supersession chain, and free of recent confirmed use.
- Archive at most 20 reviewed-safe memories per weekly run.
- Archived memories remain available to explicit history queries.

### Noise Deletion

- Only deterministic noise patterns qualify automatically.
- Quarantine candidates for seven days.
- Delete only when the candidate remains unchanged, unused, and unreferenced after quarantine.

## Retrieval Semantics

- Normal autoRecall returns only `confirmed` memories that are active at query time.
- `superseded`, `obsolete_preference`, `conflicting`, and `archived` memories do not enter normal answer context.
- Explicit history queries may retrieve superseded, obsolete, and archived memories with lifecycle labels.
- Conflicting memories remain excluded from answer context and are visible through review tools.
- Candidate over-fetching must filter lifecycle state before top-N truncation so historical rows cannot crowd out current truth.

## Failure Handling

Every governance run fails closed.

- Lock contention, schema mismatch, missing embedder, unhealthy database, or unavailable required model permits analysis only and blocks mutation.
- Every mutation records before and after metadata plus the exact rollback payload.
- Any write, read-back, re-embedding, or benchmark failure rolls back the current run.
- Rollback never touches memories created or changed by earlier runs.
- A failed run returns a non-zero exit and sends a concise failure alert.

## Observability

Persist the following for every run:

- `runId`, start/end time, trigger, and config fingerprint;
- last attempt and last successful run;
- scanned counts by scope and lifecycle state;
- proposal, applied, skipped, failed, archived, deleted, and rolled-back counts;
- skip and failure reasons;
- active/history/targeted recall benchmark deltas;
- action and rollback manifest paths;
- next scheduled run.

The cron watchdog alerts when no governance run succeeds for 26 hours, a lock remains stale, a rollback fails, or recall benchmarks regress.

## Test Strategy

### Contract Tests

- Both plugins round-trip every lifecycle state and relationship field identically.
- `supersedes` arrays survive all metadata patch and access-tracking paths.

### Unit Tests

- Confidence is not always high.
- Multi-version histories converge to one current memory.
- Cross-scope and cross-category merges are rejected.
- Update, embedding, or read-back failure results in zero deletions.
- Core protection and mutation caps are enforced.

### Integration Tests

Use an isolated LanceDB fixture containing current, superseded, obsolete, conflicting, archived, duplicate, and noise memories. Verify active recall, history recall, conflict quarantine, merge transactionality, rollback, lock contention, and idempotent reruns.

### Cron Contract Tests

- Ingestion contains no semantic delete command.
- Exactly one governance scheduler is enabled.
- Governance runs after ingestion and before storage retention.
- A failed command produces a failed cron run rather than a misleading success summary.

## Rollout

1. Fix safety and schema defects with all tests green.
2. Run seven consecutive days in shadow dry-run mode.
3. Manually review the first 20 supersession and duplicate proposals.
4. Enable metadata-only apply with a cap of three per day.
5. Verify recall and lifecycle chains for seven days.
6. Raise the daily cap to ten.
7. Enable weekly stale archive one week later.
8. Enable quarantined noise deletion only after its retention window and verification tests pass.

## Acceptance Criteria

- Governance succeeds every day and missed runs are observable and recoverable.
- Incorrect hard deletions remain zero.
- Normal recall prefers current truth and excludes obsolete recommendations.
- Explicit history queries still retrieve labeled historical memories.
- Supersession chains contain no cycles, broken links, or multiple current nodes.
- Cross-scope merges remain zero.
- Every mutation is attributable to one run and can be rolled back independently.

## Non-Goals

- Rewriting every legacy memory during the first rollout.
- Using age alone as a deletion policy.
- Allowing LLM-only destructive decisions.
- Combining filesystem/session retention with semantic memory governance.
- Keeping both the internal autoDream timer and cron governance active.
