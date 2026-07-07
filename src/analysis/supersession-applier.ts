import type {
  LanceDbAdapter,
  ParsedMetadata,
  SupersessionReason,
} from "../lancedb-adapter.js";
import { parseMetadata } from "../lancedb-adapter.js";
import type { SupersessionProposal } from "./supersession-detector.js";

export interface SupersessionApplyResult {
  applied: number;
  skipped: number;
  errors: Array<{ proposal: SupersessionProposal; error: string }>;
  entries: Array<{
    oldId: string;
    currentId: string;
    reason: SupersessionReason;
    action: SupersessionProposal["action"];
  }>;
}

export async function applySupersessionProposals(
  adapter: Pick<LanceDbAdapter, "updateMemoryMetadata">,
  proposals: SupersessionProposal[],
  opts: { maxChanges: number; now?: number },
): Promise<SupersessionApplyResult> {
  const now = opts.now ?? Date.now();
  const result: SupersessionApplyResult = {
    applied: 0,
    skipped: 0,
    errors: [],
    entries: [],
  };

  for (const proposal of proposals) {
    if (result.applied >= opts.maxChanges) {
      result.skipped++;
      continue;
    }
    if (!shouldApply(proposal)) {
      result.skipped++;
      continue;
    }

    try {
      const oldState =
        proposal.action === "mark_obsolete_preference"
          ? "obsolete_preference"
          : "superseded";
      const currentMetadata = parseMetadata(proposal.current.metadata);
      const supersedes = appendUnique(currentMetadata.supersedes, proposal.old.id);

      await adapter.updateMemoryMetadata(proposal.old.id, {
        state: oldState,
        valid_until: now,
        superseded_by: proposal.current.id,
        supersession_reason: proposal.reason,
        canonical_key: proposal.canonicalKey,
      });
      await adapter.updateMemoryMetadata(proposal.current.id, {
        state: "confirmed",
        supersedes,
        canonical_key: proposal.canonicalKey,
      });

      result.applied++;
      result.entries.push({
        oldId: proposal.old.id,
        currentId: proposal.current.id,
        reason: proposal.reason,
        action: proposal.action,
      });
    } catch (err) {
      result.errors.push({
        proposal,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

function shouldApply(proposal: SupersessionProposal): boolean {
  if (proposal.confidence !== "high" || proposal.action === "flag_conflict") {
    return false;
  }

  const oldMetadata = parseMetadata(proposal.old.metadata);
  if (oldMetadata.tier !== "core") {
    return true;
  }

  return (
    proposal.reason === "preference_changed" &&
    proposal.current.importance >= proposal.old.importance
  );
}

function appendUnique(existing: ParsedMetadata["supersedes"], id: string): string[] {
  const values = Array.isArray(existing)
    ? existing
    : existing
      ? [existing]
      : [];
  return values.includes(id) ? values : [...values, id];
}
