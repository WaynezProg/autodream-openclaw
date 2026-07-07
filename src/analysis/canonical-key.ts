import type { MemoryRecord } from "../lancedb-adapter.js";
import { parseMetadata } from "../lancedb-adapter.js";

const CONFIG_NAME_PATTERNS = [
  /(?:cron|job|name|id)\s*[:=：]\s*([A-Za-z0-9_.:/-]+)/i,
  /([A-Za-z0-9_.-]*(?:cron|cleanup|sync|session2memory)[A-Za-z0-9_.-]*)/i,
];

const MODEL_PATTERNS = [
  /model\s*[:=：]\s*([A-Za-z0-9_.:/-]+)/i,
  /模型[：:\s]*([A-Za-z0-9_.:/-]+)/i,
  /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+)/,
];

const WORKFLOW_PATTERNS: Array<[RegExp, string]> = [
  [/(session[-\s]?cleanup|session cleanup|session-clean)/i, "workflow:session-cleanup"],
  [/(session2memory)/i, "workflow:session2memory"],
  [/(recall[-\s]?tracker|recall tracker)/i, "workflow:recall-tracker"],
  [/(memory[-\s]?supersession|supersession governance)/i, "workflow:memory-supersession"],
];

const PREFERENCE_PATTERNS: Array<[RegExp, string]> = [
  [/(browser|瀏覽器).*(tool|工具|routing|路由)|(?:tool|工具|routing|路由).*(browser|瀏覽器)/i, "preference:browser-tool-routing"],
  [/(model|模型).*(policy|策略|偏好|prefer)|(?:prefer|偏好).*(model|模型)/i, "preference:model-policy"],
  [/(recommend|推薦).*(tool|工具)|(?:tool|工具).*(recommend|推薦)/i, "preference:tool-recommendation"],
];

export function deriveCanonicalKey(memory: MemoryRecord): string | null {
  const metadata = parseMetadata(memory.metadata);

  if (metadata.canonical_key && metadata.canonical_key.trim() !== "") {
    return normalizeKey(metadata.canonical_key);
  }

  const explicit = parseExplicitCanonicalKey(memory.text);
  if (explicit) {
    return explicit;
  }

  const configKey = deriveConfigKey(memory.text);
  if (configKey) {
    return configKey;
  }

  const preferenceKey = derivePatternKey(memory.text, PREFERENCE_PATTERNS);
  if (preferenceKey && hasPreferenceSignal(memory.text)) {
    return preferenceKey;
  }

  const workflowKey = derivePatternKey(memory.text, WORKFLOW_PATTERNS);
  if (workflowKey && hasWorkflowSignal(memory.text)) {
    return workflowKey;
  }

  return null;
}

export function parseExplicitCanonicalKey(text: string): string | null {
  const keyMatch = text.match(/(?:canonical_key|canonicalKey)\s*[:=：]\s*([A-Za-z0-9_:/.-]+)/i);
  if (keyMatch?.[1]) {
    return normalizeKey(keyMatch[1]);
  }

  const decisionMatch = text.match(/#decision\s*[:：]\s*([A-Za-z0-9_:/.-]+)/i);
  if (decisionMatch?.[1]?.includes(":")) {
    return normalizeKey(decisionMatch[1]);
  }

  return null;
}

function deriveConfigKey(text: string): string | null {
  const lower = text.toLowerCase();
  const hasConfigSignal =
    /\b(config|cron|job|payload|model|scope|database_id|data_source_id)\b/i.test(text) ||
    /(設定|排程|模型)/.test(text);
  if (!hasConfigSignal) {
    return null;
  }

  const configName = firstMatch(text, CONFIG_NAME_PATTERNS);
  const model = firstMatch(text, MODEL_PATTERNS);

  if (configName && model) {
    if (lower.includes("cron") || lower.includes("排程")) {
      return `config:cron-model:${slug(configName)}`;
    }
    return `config:model:${slug(configName)}`;
  }

  const dotted = text.match(/\b([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)\s*[:=：]\s*([A-Za-z0-9_.:/-]+)/);
  if (dotted?.[1]) {
    return `config:${slug(dotted[1])}`;
  }

  return null;
}

function derivePatternKey(text: string, patterns: Array<[RegExp, string]>): string | null {
  for (const [pattern, key] of patterns) {
    if (pattern.test(text)) {
      return key;
    }
  }
  return null;
}

function hasPreferenceSignal(text: string): boolean {
  return /(喜歡|偏好|推薦|不要推薦|不喜歡|prefer|preference|recommend)/i.test(text);
}

function hasWorkflowSignal(text: string): boolean {
  return /(workflow|流程|sop|cron|cleanup|session2memory|清理|排程)/i.test(text);
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function normalizeKey(key: string): string | null {
  const trimmed = key.trim().replace(/[),.;，。]+$/g, "");
  if (!trimmed || ["model", "preference", "cron"].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function slug(value: string): string {
  return value
    .trim()
    .replace(/[),.;，。]+$/g, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s:/]+/g, "-")
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
