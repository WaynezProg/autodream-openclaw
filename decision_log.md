# Decision Log

## 2026-07-12 - Cron-driven single memory-governance pipeline

### Problem

OpenClaw currently has several independent memory jobs. None directly invokes autoDream, some import or delete memories independently, and the autoDream internal scheduler is not reliable across gateway restarts. Lifecycle metadata also differs between autoDream and memory-lancedb-pro.

### Options Considered

1. Use one cron-driven governance pipeline, with autoDream as the semantic engine and memory-lancedb-pro as the storage and retrieval owner.
2. Keep and repair the autoDream internal scheduler while cron jobs continue to perform adjacent memory work.
3. Disable autoDream scheduling and reproduce all governance logic in cron scripts.

### Decision

Choose option 1.

Cron provides deterministic ordering, monitoring, and failure delivery. autoDream remains the single semantic-governance implementation. memory-lancedb-pro owns the shared lifecycle schema, atomic mutation, and retrieval behavior. Existing ingestion and retention jobs lose semantic deletion authority.

### Why

- One semantic writer prevents conflicting delete and supersession policies.
- Cron provides better restart recovery and run observability than an in-memory timer.
- Keeping semantic logic inside autoDream avoids duplicating rules in prompts and scripts.
- Keeping storage semantics inside memory-lancedb-pro makes active and historical retrieval consistent.

### Rejected Options

Option 2 was rejected because restart-sensitive session gating and two scheduling systems would remain. Option 3 was rejected because duplicate lifecycle logic would drift between scripts and plugins.

### Consequences

- autoDream needs a scheduler disable switch and a deterministic command entrypoint.
- The current standalone safe-curation cron must be integrated or disabled.
- lancedb-daily-sync becomes import, backup, and reporting only.
- Both plugins must share one lifecycle contract before apply mode can be enabled.
- Rollout begins in shadow mode and enables bounded mutation only after manual review and recall verification.
