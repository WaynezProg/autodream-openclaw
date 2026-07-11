import type { MemoryRecord } from "../lancedb-adapter.js";

export interface DedupPair {
  a: MemoryRecord;
  b: MemoryRecord;
  similarity: number;
  keywordOverlap: number;
  keep: MemoryRecord;
  merge: MemoryRecord;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 選擇要保留的記憶：優先保留 importance 較高者，
 * 相同則保留 text 較長者（通常資訊更完整），
 * 再相同則保留較新者。
 */
function chooseKeep(a: MemoryRecord, b: MemoryRecord): [MemoryRecord, MemoryRecord] {
  if (a.importance !== b.importance) {
    return a.importance >= b.importance ? [a, b] : [b, a];
  }
  if (a.text.length !== b.text.length) {
    return a.text.length >= b.text.length ? [a, b] : [b, a];
  }
  return a.timestamp >= b.timestamp ? [a, b] : [b, a];
}

export interface DedupOptions {
  /** Vector cosine similarity threshold (default: 0.90) */
  vectorThreshold?: number;
  /** Minimum keyword overlap to consider (default: 0.3) */
  keywordMinOverlap?: number;
}

/**
 * 偵測重複記憶對。
 * 使用向量 cosine similarity 為主要判斷，keyword jaccard 為輔助驗證。
 */
export function detectDuplicates(
  records: MemoryRecord[],
  opts?: DedupOptions,
): DedupPair[] {
  const vectorThreshold = opts?.vectorThreshold ?? 0.90;
  const keywordMinOverlap = opts?.keywordMinOverlap ?? 0.3;
  const pairs: DedupPair[] = [];

  // 預先計算 keywords
  const keywords = records.map((r) => extractKeywords(r.text));

  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];

      if (a.scope !== b.scope || a.category !== b.category) continue;

      // 跳過沒有 vector 的記憶
      if (a.vector.length === 0 || b.vector.length === 0) continue;

      const similarity = cosineSimilarity(a.vector, b.vector);
      if (similarity < vectorThreshold) continue;

      const keywordOverlap = jaccardSimilarity(keywords[i], keywords[j]);
      if (keywordOverlap < keywordMinOverlap) continue;

      const [keep, merge] = chooseKeep(a, b);

      pairs.push({
        a,
        b,
        similarity,
        keywordOverlap,
        keep,
        merge,
      });
    }
  }

  // 按相似度降序排列
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}
