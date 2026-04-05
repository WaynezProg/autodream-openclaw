import type { MemoryRecord } from "../lancedb-adapter.js";
import { cosineSimilarity } from "./dedup-detector.js";
import type { LlmHelper } from "./llm-helper.js";

export interface ConflictPair {
  a: MemoryRecord;
  b: MemoryRecord;
  similarity: number;
  reason: string;
  ruleMatched: string;
}

interface ConflictRule {
  name: string;
  test: (a: MemoryRecord, b: MemoryRecord) => string | null;
}

const AFFIRM_NEGATE_RULES: Array<{
  name: string;
  affirm: RegExp;
  negate: RegExp;
}> = [
  {
    name: "enable-disable",
    affirm: /啟用|開啟|enable/i,
    negate: /停用|關閉|disable/i,
  },
  {
    name: "complete-incomplete",
    affirm: /已完成|已做完|completed/i,
    negate: /尚未完成|還沒做|未完成|not\s*completed/i,
  },
  {
    name: "use-avoid",
    affirm: /應該用|使用|推薦用/,
    negate: /不要用|避免|不推薦/,
  },
  {
    name: "true-false",
    affirm: /(?<![不])是|正確|true/i,
    negate: /不是|錯誤|false/i,
  },
];

const VALUE_PATTERN = /(\w+)\s*[:=：]\s*(\S+)/g;

function buildRules(): ConflictRule[] {
  const rules: ConflictRule[] = AFFIRM_NEGATE_RULES.map((r) => ({
    name: r.name,
    test: (a, b) => {
      if (
        (r.affirm.test(a.text) && r.negate.test(b.text)) ||
        (r.negate.test(a.text) && r.affirm.test(b.text))
      ) {
        return `One affirms (${r.affirm.source}) while the other negates (${r.negate.source})`;
      }
      return null;
    },
  }));

  rules.push({
    name: "value-conflict",
    test: (a, b) => {
      const aKV = new Map<string, string>();
      for (const m of a.text.matchAll(VALUE_PATTERN)) {
        aKV.set(m[1].toLowerCase(), m[2]);
      }
      for (const m of b.text.matchAll(VALUE_PATTERN)) {
        const key = m[1].toLowerCase();
        const aVal = aKV.get(key);
        if (aVal !== undefined && aVal !== m[2]) {
          return `Key "${key}" has conflicting values: "${aVal}" vs "${m[2]}"`;
        }
      }
      return null;
    },
  });

  return rules;
}

const CONFLICT_RULES = buildRules();

const SIM_LOW = 0.60;
const SIM_HIGH = 0.85;

/** Ambiguous pair: similarity 0.60-0.75 with no rule match — candidate for LLM confirmation */
export interface AmbiguousPair {
  a: MemoryRecord;
  b: MemoryRecord;
  similarity: number;
}

const SIM_AMBIGUOUS_HIGH = 0.75;

export function detectConflicts(memories: MemoryRecord[]): ConflictPair[] {
  return detectConflictsWithAmbiguous(memories).confirmed;
}

/**
 * Returns both rule-confirmed conflicts and ambiguous pairs.
 * Ambiguous pairs (sim 0.60-0.75, no rule match) can be passed to LLM.
 */
export function detectConflictsWithAmbiguous(memories: MemoryRecord[]): {
  confirmed: ConflictPair[];
  ambiguous: AmbiguousPair[];
} {
  // Group by scope + category
  const groups = new Map<string, MemoryRecord[]>();
  for (const m of memories) {
    const key = `${m.scope}::${m.category}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(m);
  }

  const confirmed: ConflictPair[] = [];
  const ambiguous: AmbiguousPair[] = [];

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        if (a.vector.length === 0 || b.vector.length === 0) continue;

        const sim = cosineSimilarity(a.vector, b.vector);
        if (sim < SIM_LOW || sim > SIM_HIGH) continue;

        let matched = false;
        for (const rule of CONFLICT_RULES) {
          const reason = rule.test(a, b);
          if (reason) {
            confirmed.push({
              a,
              b,
              similarity: sim,
              reason,
              ruleMatched: rule.name,
            });
            matched = true;
            break; // one rule per pair
          }
        }

        // Ambiguous: in the lower similarity range with no rule match
        if (!matched && sim <= SIM_AMBIGUOUS_HIGH) {
          ambiguous.push({ a, b, similarity: sim });
        }
      }
    }
  }

  return { confirmed, ambiguous };
}

/**
 * Use LLM to confirm whether ambiguous pairs are actually contradictory.
 */
export async function confirmConflictsWithLlm(
  ambiguous: AmbiguousPair[],
  llm: LlmHelper | null,
): Promise<ConflictPair[]> {
  if (!llm || ambiguous.length === 0) return [];

  const results: ConflictPair[] = [];

  for (const pair of ambiguous) {
    if (llm.exhausted) break;

    const prompt = [
      "Are these two memories contradictory? Answer YES or NO, then explain in 1 sentence.",
      "",
      `Memory A: ${pair.a.text}`,
      `Memory B: ${pair.b.text}`,
    ].join("\n");

    const response = await llm.ask(prompt);
    if (response && /^YES\b/i.test(response.trim())) {
      const explanation = response.replace(/^YES[.:,\s]*/i, "").trim();
      results.push({
        a: pair.a,
        b: pair.b,
        similarity: pair.similarity,
        reason: explanation || "LLM confirmed contradiction",
        ruleMatched: "llm-confirmed",
      });
    }
  }

  return results;
}
