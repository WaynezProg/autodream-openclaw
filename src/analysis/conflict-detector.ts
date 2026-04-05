import type { MemoryRecord } from "../lancedb-adapter.js";
import { cosineSimilarity } from "./dedup-detector.js";

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
    affirm: /是|正確|true/i,
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

export function detectConflicts(memories: MemoryRecord[]): ConflictPair[] {
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

  const results: ConflictPair[] = [];

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        if (a.vector.length === 0 || b.vector.length === 0) continue;

        const sim = cosineSimilarity(a.vector, b.vector);
        if (sim < SIM_LOW || sim > SIM_HIGH) continue;

        for (const rule of CONFLICT_RULES) {
          const reason = rule.test(a, b);
          if (reason) {
            results.push({
              a,
              b,
              similarity: sim,
              reason,
              ruleMatched: rule.name,
            });
            break; // one rule per pair
          }
        }
      }
    }
  }

  return results;
}
