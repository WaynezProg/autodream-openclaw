import type {
  MemoryRecord,
  SupersessionReason,
} from "../lancedb-adapter.js";
import { parseMetadata } from "../lancedb-adapter.js";
import { deriveCanonicalKey } from "./canonical-key.js";

export type SupersessionConfidence = "high" | "medium" | "low";

export interface SupersessionProposal {
  old: MemoryRecord;
  current: MemoryRecord;
  canonicalKey: string;
  reason: SupersessionReason;
  confidence: SupersessionConfidence;
  evidence: string[];
  action: "mark_superseded" | "mark_obsolete_preference" | "flag_conflict";
}

const SUPPORTED_CATEGORIES = new Set(["decision", "fact", "preference"]);

export function detectSupersessionProposals(
  memories: MemoryRecord[],
): SupersessionProposal[] {
  const proposals: SupersessionProposal[] = [];
  const keyed = memories
    .map((memory) => ({ memory, canonicalKey: deriveCanonicalKey(memory) }))
    .filter((entry): entry is { memory: MemoryRecord; canonicalKey: string } =>
      Boolean(entry.canonicalKey),
    );

  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i];
      const b = keyed[j];
      if (!canCompare(a.memory, b.memory) || a.canonicalKey !== b.canonicalKey) {
        continue;
      }

      const [oldEntry, currentEntry] =
        a.memory.timestamp <= b.memory.timestamp ? [a, b] : [b, a];
      const proposal = classifyPair(
        oldEntry.memory,
        currentEntry.memory,
        currentEntry.canonicalKey,
      );
      if (proposal) {
        proposals.push(proposal);
      }
    }
  }

  return reduceSupersessionChains(dedupeProposals(proposals));
}

function canCompare(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.id === b.id || a.scope !== b.scope) {
    return false;
  }
  return (
    a.category === b.category &&
    SUPPORTED_CATEGORIES.has(a.category) &&
    SUPPORTED_CATEGORIES.has(b.category)
  );
}

function classifyPair(
  oldMemory: MemoryRecord,
  currentMemory: MemoryRecord,
  canonicalKey: string,
): SupersessionProposal | null {
  const oldMeta = parseMetadata(oldMemory.metadata);
  const currentMeta = parseMetadata(currentMemory.metadata);
  if (oldMeta.state === "superseded" || oldMeta.state === "obsolete_preference") {
    return null;
  }

  const currentText = currentMemory.text;
  const oldText = oldMemory.text;
  const evidence: string[] = [];
  const explicitCanonicalMatch =
    Boolean(oldMeta.canonical_key) &&
    Boolean(currentMeta.canonical_key) &&
    oldMeta.canonical_key === currentMeta.canonical_key;

  if (isConfigDrift(oldText, currentText)) {
    evidence.push("newer memory changes a concrete config value");
    return buildProposal(oldMemory, currentMemory, canonicalKey, "config_drift", "mark_superseded", evidence);
  }

  if (
    currentMemory.category === "preference" &&
    oldMemory.category === "preference" &&
    hasPreferenceChangeSignal(currentText)
  ) {
    evidence.push("newer preference contains change signal");
    if (currentMeta.canonical_key || oldMeta.canonical_key) {
      evidence.push("canonical_key matched");
    }
    return buildProposal(oldMemory, currentMemory, canonicalKey, "preference_changed", "mark_obsolete_preference", evidence);
  }

  if (
    hasMethodMigrationSignal(currentText) &&
    (oldMemory.category === currentMemory.category || currentMemory.category === "decision")
  ) {
    evidence.push("newer memory contains migration/deprecation signal");
    if (explicitCanonicalMatch) {
      evidence.push("explicit canonical_key matched on both memories");
    }
    if (mentionsReplacedMethod(oldText, currentText)) {
      evidence.push("older memory appears to mention the replaced method");
    }
    return buildProposal(oldMemory, currentMemory, canonicalKey, "method_migration", "mark_superseded", evidence);
  }

  if (hasNewerDecisionSignal(currentText) && oldMemory.category === "decision") {
    evidence.push("newer memory contains decision replacement signal");
    return buildProposal(oldMemory, currentMemory, canonicalKey, "newer_decision", "mark_superseded", evidence);
  }

  return null;
}

function buildProposal(
  oldMemory: MemoryRecord,
  currentMemory: MemoryRecord,
  canonicalKey: string,
  reason: SupersessionReason,
  action: SupersessionProposal["action"],
  evidence: string[],
): SupersessionProposal {
  return {
    old: oldMemory,
    current: currentMemory,
    canonicalKey,
    reason,
    confidence:
      evidence.length >= 3 ? "high" : evidence.length === 2 ? "medium" : "low",
    evidence,
    action,
  };
}

function hasMethodMigrationSignal(text: string): boolean {
  return /(改用|起改|改為|改成|不再使用|deprecated|superseded|replace[ds]?|migrat(?:e|ed|ion))/i.test(text);
}

function hasPreferenceChangeSignal(text: string): boolean {
  return /(現在偏好|改成|改用|不要推薦|不喜歡|prefer .+ over .+|now prefer|no longer recommend)/i.test(text);
}

function hasNewerDecisionSignal(text: string): boolean {
  return /(#decision|決定|改為|改成|新的策略|new decision)/i.test(text);
}

function isConfigDrift(oldText: string, currentText: string): boolean {
  const oldValues = extractConfigValues(oldText);
  const currentValues = extractConfigValues(currentText);
  for (const [key, oldValue] of oldValues) {
    const currentValue = currentValues.get(key);
    if (currentValue && currentValue !== oldValue) {
      return true;
    }
  }
  return false;
}

function extractConfigValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const patterns = [
    /\b(model|scope|database_id|data_source_id|enabled)\s*[:=：]\s*([A-Za-z0-9_.:/-]+)/gi,
    /\b([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)\s*[:=：]\s*([A-Za-z0-9_.:/-]+)/g,
    /模型[：:\s]*([A-Za-z0-9_.:/-]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[2]) {
        values.set(match[1].toLowerCase(), match[2].toLowerCase());
      } else if (match[1]) {
        values.set("model", match[1].toLowerCase());
      }
    }
  }
  return values;
}

function mentionsReplacedMethod(oldText: string, currentText: string): boolean {
  const oldTokens = significantTokens(oldText);
  const currentTokens = significantTokens(currentText);
  return oldTokens.some((token) => currentTokens.includes(token));
}

function significantTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .match(/[A-Za-z0-9_.:/-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [],
    ),
  ).filter((token) => !["使用", "改用", "方法", "處理", "記憶", "model"].includes(token));
}

function dedupeProposals(proposals: SupersessionProposal[]): SupersessionProposal[] {
  const seen = new Set<string>();
  const result: SupersessionProposal[] = [];
  for (const proposal of proposals) {
    const key = `${proposal.old.id}->${proposal.current.id}:${proposal.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(proposal);
    }
  }
  return result;
}

export function reduceSupersessionChains(
  proposals: SupersessionProposal[],
): SupersessionProposal[] {
  const groups = new Map<string, SupersessionProposal[]>();
  for (const proposal of proposals) {
    const key = `${proposal.old.scope}\u0000${proposal.old.category}\u0000${proposal.canonicalKey}`;
    const group = groups.get(key) ?? [];
    group.push(proposal);
    groups.set(key, group);
  }

  const reduced: SupersessionProposal[] = [];
  for (const group of groups.values()) {
    const memories = new Map<string, MemoryRecord>();
    for (const proposal of group) {
      memories.set(proposal.old.id, proposal.old);
      memories.set(proposal.current.id, proposal.current);
    }
    const ordered = [...memories.values()].sort(
      (a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id),
    );
    const current = ordered[0];
    if (!current) continue;

    for (const old of ordered.slice(1)) {
      const direct = group.find(
        (proposal) =>
          proposal.old.id === old.id && proposal.current.id === current.id,
      );
      const template = direct ?? group.find((proposal) => proposal.old.id === old.id);
      if (!template) continue;
      reduced.push({ ...template, old, current });
    }
  }

  return reduced;
}
