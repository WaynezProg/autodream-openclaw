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
  adapter: Pick<
    LanceDbAdapter,
    "getMemoryById" | "replaceMemoryMetadata" | "updateMemoryMetadata"
  >,
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

    let beforeOldMetadata = proposal.old.metadata;
    let beforeCurrentMetadata = proposal.current.metadata;
    try {
      const beforeOld = await adapter.getMemoryById(proposal.old.id);
      const beforeCurrent = await adapter.getMemoryById(proposal.current.id);
      if (!beforeOld || !beforeCurrent) {
        throw new Error("Supersession row missing before mutation");
      }
      beforeOldMetadata = beforeOld.metadata;
      beforeCurrentMetadata = beforeCurrent.metadata;
      if (
        parseMetadata(beforeOld.metadata).tier === "core" ||
        parseMetadata(beforeCurrent.metadata).tier === "core"
      ) {
        result.skipped++;
        continue;
      }
      const oldState =
        proposal.action === "mark_obsolete_preference"
          ? "obsolete_preference"
          : "superseded";
      const currentMetadata = parseMetadata(proposal.current.metadata);
      const supersedes = appendUnique(currentMetadata.supersedes, proposal.old.id);

      const oldUpdated = await adapter.updateMemoryMetadata(proposal.old.id, {
        state: oldState,
        invalidated_at: now,
        superseded_by: proposal.current.id,
        supersession_reason: proposal.reason,
        canonical_key: proposal.canonicalKey,
      });
      if (!oldUpdated) throw new Error("Old memory metadata update returned false");
      const currentUpdated = await adapter.updateMemoryMetadata(proposal.current.id, {
        state: "confirmed",
        supersedes,
        canonical_key: proposal.canonicalKey,
      });
      if (!currentUpdated) throw new Error("Current memory metadata update returned false");

      const afterOld = await adapter.getMemoryById(proposal.old.id);
      const afterCurrent = await adapter.getMemoryById(proposal.current.id);
      const oldMeta = afterOld ? parseMetadata(afterOld.metadata) : {};
      const currentMeta = afterCurrent ? parseMetadata(afterCurrent.metadata) : {};
      if (
        oldMeta.invalidated_at !== now ||
        oldMeta.superseded_by !== proposal.current.id ||
        !currentMeta.supersedes?.includes(proposal.old.id)
      ) {
        throw new Error("Supersession read-back verification failed");
      }

      result.applied++;
      result.entries.push({
        oldId: proposal.old.id,
        currentId: proposal.current.id,
        reason: proposal.reason,
        action: proposal.action,
      });
    } catch (err) {
      const rollback = await Promise.allSettled([
        adapter.replaceMemoryMetadata(proposal.old.id, beforeOldMetadata),
        adapter.replaceMemoryMetadata(proposal.current.id, beforeCurrentMetadata),
      ]);
      const rollbackFailed = rollback.some(
        (item) => item.status === "rejected" || item.value !== true,
      );
      const originalError = err instanceof Error ? err.message : String(err);
      result.errors.push({
        proposal,
        error: rollbackFailed ? `${originalError}; rollback failed` : originalError,
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
  const currentMetadata = parseMetadata(proposal.current.metadata);
  return oldMetadata.tier !== "core" && currentMetadata.tier !== "core";
}

function appendUnique(existing: ParsedMetadata["supersedes"], id: string): string[] {
  const values = Array.isArray(existing)
    ? existing
    : existing
      ? [existing]
      : [];
  return values.includes(id) ? values : [...values, id];
}
