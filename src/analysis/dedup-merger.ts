/**
 * Dedup Merger — uses LLM to merge duplicate memory pairs into concise entries.
 *
 * Only activated when autoMergeDuplicates=true and LLM is available.
 */

import type { DedupPair } from "./dedup-detector.js";
import type { LlmHelper } from "./llm-helper.js";

export interface MergeResult {
  pair: DedupPair;
  mergedText: string;
  /** IDs of original memories to mark for deletion */
  originalsToDelete: string[];
  /** ID of the memory to keep (with updated text) */
  keepId: string;
}

/**
 * Use LLM to merge duplicate pairs into single consolidated entries.
 * Returns results only for pairs where LLM successfully produced a merge.
 */
export async function mergeWithLlm(
  pairs: DedupPair[],
  llm: LlmHelper | null,
): Promise<MergeResult[]> {
  if (!llm || pairs.length === 0) return [];

  const results: MergeResult[] = [];

  for (const pair of pairs) {
    if (llm.exhausted) break;

    const prompt = buildMergePrompt(pair);
    const response = await llm.ask(prompt);

    if (response) {
      const mergedText = response.trim();
      // Only accept if the merge is actually shorter or comparable to originals
      const maxOrigLen = Math.max(pair.a.text.length, pair.b.text.length);
      if (mergedText.length > 0 && mergedText.length <= maxOrigLen * 2) {
        results.push({
          pair,
          mergedText,
          keepId: pair.keep.id,
          originalsToDelete: [pair.merge.id],
        });
      }
    }
  }

  return results;
}

function buildMergePrompt(pair: DedupPair): string {
  return [
    "Merge these two similar memories into one concise entry preserving all key information.",
    "Return ONLY the merged text, nothing else.",
    "",
    `Memory A: ${pair.a.text}`,
    `Memory B: ${pair.b.text}`,
  ].join("\n");
}
