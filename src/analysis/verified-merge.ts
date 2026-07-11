import type { DedupPair } from "./dedup-detector.js";
import type { MergeResult } from "./dedup-merger.js";
import type { LanceDbAdapter } from "../lancedb-adapter.js";
import { parseMetadata } from "../lancedb-adapter.js";

export interface VerifiedMergeResult {
  status: "applied" | "rejected" | "failed" | "rollback_failed";
  reason?: string;
}

export async function applyVerifiedMerge(args: {
  adapter: Pick<
    LanceDbAdapter,
    "deleteMemory" | "getMemoryById" | "updateMemoryTextAndVector"
  >;
  merge: MergeResult;
  embedder: { embed(text: string): Promise<number[]> };
}): Promise<VerifiedMergeResult> {
  const { adapter, embedder, merge } = args;
  const pair: DedupPair = merge.pair;
  if (pair.a.scope !== pair.b.scope || pair.a.category !== pair.b.category) {
    return { status: "rejected", reason: "cross_scope_or_category" };
  }
  if (
    parseMetadata(pair.a.metadata).tier === "core" ||
    parseMetadata(pair.b.metadata).tier === "core"
  ) {
    return { status: "rejected", reason: "core_protected" };
  }

  const before = await adapter.getMemoryById(merge.keepId);
  if (!before) return { status: "failed", reason: "keep_row_missing" };
  const freshRows = [before];
  for (const id of [pair.a.id, pair.b.id]) {
    if (id === merge.keepId) continue;
    const row = await adapter.getMemoryById(id);
    if (!row) return { status: "failed", reason: `merge_row_missing:${id}` };
    freshRows.push(row);
  }
  if (freshRows.some((row) => parseMetadata(row.metadata).tier === "core")) {
    return { status: "rejected", reason: "core_protected" };
  }

  let newVector: number[];
  try {
    newVector = await embedder.embed(merge.mergedText);
  } catch (error) {
    return {
      status: "failed",
      reason: `embed_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (newVector.length === 0 || newVector.length !== before.vector.length) {
    return { status: "failed", reason: "vector_dimension_mismatch" };
  }

  const updated = await adapter.updateMemoryTextAndVector(
    merge.keepId,
    merge.mergedText,
    newVector,
  );
  if (!updated) return { status: "failed", reason: "update_failed" };

  const readBack = await adapter.getMemoryById(merge.keepId);
  if (
    !readBack ||
    readBack.text !== merge.mergedText ||
    readBack.vector.length !== newVector.length
  ) {
    const rolledBack = await adapter.updateMemoryTextAndVector(
      before.id,
      before.text,
      before.vector,
    );
    return rolledBack
      ? { status: "failed", reason: "read_back_mismatch" }
      : { status: "rollback_failed", reason: "read_back_mismatch" };
  }

  for (const id of merge.originalsToDelete) {
    const deleted = await adapter.deleteMemory(id);
    if (!deleted) {
      const rolledBack = await adapter.updateMemoryTextAndVector(
        before.id,
        before.text,
        before.vector,
      );
      return rolledBack
        ? { status: "failed", reason: `delete_failed:${id}` }
        : { status: "rollback_failed", reason: `delete_failed:${id}` };
    }
  }
  return { status: "applied" };
}
