import type { DedupPair } from "../analysis/dedup-detector.js";
import type { TimeFixEntry } from "../analysis/time-normalizer.js";
import type { ConflictPair } from "../analysis/conflict-detector.js";
import type { StaleEntry } from "../analysis/staleness-scorer.js";
import type { MergeResult } from "../analysis/dedup-merger.js";

export interface DreamReport {
  timestamp: string;
  scanned: number;
  duplicates: {
    count: number;
    pairs: Array<{
      a: { id: string; text: string; scope: string };
      b: { id: string; text: string; scope: string };
      similarity: number;
      keywordOverlap: number;
      action: "merge" | "flag";
    }>;
  };
  timeIssues: {
    count: number;
    entries: Array<{
      id: string;
      original: string;
      resolved: string;
      confidence: string;
    }>;
  };
  conflicts: {
    count: number;
    pairs: Array<{
      a: { id: string; text: string };
      b: { id: string; text: string };
      reason: string;
      ruleMatched: string;
    }>;
  };
  stale: {
    count: number;
    entries: Array<{
      id: string;
      text: string;
      score: number;
      factors: { ageDays: number; accessCount: number; importance: number };
    }>;
  };
  merges?: {
    count: number;
    entries: Array<{
      keepId: string;
      deleteIds: string[];
      mergedText: string;
    }>;
  };
  llmCallsUsed?: number;
  timeFixesApplied?: number;
  dryRun: boolean;
}

export function buildReport(
  scanned: number,
  dedupPairs: DedupPair[],
  timeIssues: TimeFixEntry[],
  conflicts: ConflictPair[],
  staleItems: StaleEntry[],
  dryRun: boolean,
  autoMerge: boolean,
  merges?: MergeResult[],
  llmCallsUsed?: number,
  timeFixesApplied?: number,
): DreamReport {
  return {
    timestamp: new Date().toISOString(),
    scanned,
    duplicates: {
      count: dedupPairs.length,
      pairs: dedupPairs.map((p) => ({
        a: { id: p.a.id, text: truncate(p.a.text, 120), scope: p.a.scope },
        b: { id: p.b.id, text: truncate(p.b.text, 120), scope: p.b.scope },
        similarity: round(p.similarity, 4),
        keywordOverlap: round(p.keywordOverlap, 4),
        action: autoMerge && !dryRun ? ("merge" as const) : ("flag" as const),
      })),
    },
    timeIssues: {
      count: timeIssues.length,
      entries: timeIssues.map((t) => ({
        id: t.memory.id,
        original: t.original,
        resolved: t.resolved,
        confidence: t.confidence,
      })),
    },
    conflicts: {
      count: conflicts.length,
      pairs: conflicts.map((c) => ({
        a: { id: c.a.id, text: truncate(c.a.text, 120) },
        b: { id: c.b.id, text: truncate(c.b.text, 120) },
        reason: c.reason,
        ruleMatched: c.ruleMatched,
      })),
    },
    stale: {
      count: staleItems.length,
      entries: staleItems.map((s) => ({
        id: s.memory.id,
        text: truncate(s.memory.text, 120),
        score: round(s.score, 4),
        factors: {
          ageDays: round(s.factors.ageDays, 1),
          accessCount: s.factors.accessCount,
          importance: s.factors.importance,
        },
      })),
    },
    merges:
      merges && merges.length > 0
        ? {
            count: merges.length,
            entries: merges.map((m) => ({
              keepId: m.keepId,
              deleteIds: m.originalsToDelete,
              mergedText: truncate(m.mergedText, 200),
            })),
          }
        : undefined,
    llmCallsUsed,
    timeFixesApplied: timeFixesApplied ?? 0,
    dryRun,
  };
}

export function formatReportMarkdown(report: DreamReport): string {
  const lines: string[] = [
    `# 🧠 autoDream Report`,
    ``,
    `**Time:** ${report.timestamp}`,
    `**Scanned:** ${report.scanned} memories`,
    `**Dry-run:** ${report.dryRun ? "Yes" : "No"}`,
    ``,
    `## Duplicates (${report.duplicates.count})`,
    ``,
  ];

  if (report.duplicates.pairs.length === 0) {
    lines.push("No duplicates found.");
  } else {
    for (const pair of report.duplicates.pairs) {
      lines.push(
        `- **${pair.similarity.toFixed(2)}** similarity | ` +
          `**${pair.keywordOverlap.toFixed(2)}** keyword overlap | ` +
          `action: **${pair.action}**`,
      );
      lines.push(`  - A: \`${pair.a.id}\` — ${pair.a.text}`);
      lines.push(`  - B: \`${pair.b.id}\` — ${pair.b.text}`);
      lines.push(``);
    }
  }

  const timeFixLabel = report.timeFixesApplied
    ? ` — ✅ ${report.timeFixesApplied} fixed`
    : "";
  lines.push(`## Time Issues (${report.timeIssues.count}${timeFixLabel})`);
  lines.push(``);
  if (report.timeIssues.entries.length === 0) {
    lines.push("No relative time expressions found.");
  } else {
    for (const entry of report.timeIssues.entries) {
      const resolved =
        entry.confidence === "high"
          ? `→ ${entry.resolved}`
          : "(fuzzy, not resolved)";
      lines.push(
        `- \`${entry.id}\` — "${entry.original}" ${resolved} [${entry.confidence}]`,
      );
    }
  }

  lines.push(``);
  lines.push(`## Conflicts (${report.conflicts.count})`);
  lines.push(``);
  if (report.conflicts.pairs.length === 0) {
    lines.push("No conflicts detected.");
  } else {
    for (const pair of report.conflicts.pairs) {
      lines.push(
        `- **${pair.ruleMatched}**: ${pair.reason}`,
      );
      lines.push(`  - A: \`${pair.a.id}\` — ${pair.a.text}`);
      lines.push(`  - B: \`${pair.b.id}\` — ${pair.b.text}`);
      lines.push(``);
    }
  }

  lines.push(`## Stale Memories (${report.stale.count})`);
  lines.push(``);
  if (report.stale.entries.length === 0) {
    lines.push("No stale memories found.");
  } else {
    for (const entry of report.stale.entries) {
      lines.push(
        `- \`${entry.id}\` — score: **${entry.score.toFixed(2)}** | ` +
          `age: ${entry.factors.ageDays}d | ` +
          `access: ${entry.factors.accessCount} | ` +
          `importance: ${entry.factors.importance}`,
      );
      lines.push(`  ${entry.text}`);
      lines.push(``);
    }
  }

  if (report.merges && report.merges.count > 0) {
    lines.push(``);
    lines.push(`## LLM Merges (${report.merges.count})`);
    lines.push(``);
    for (const entry of report.merges.entries) {
      lines.push(
        `- Keep \`${entry.keepId}\`, delete ${entry.deleteIds.map((id) => `\`${id}\``).join(", ")}`,
      );
      lines.push(`  Merged: ${entry.mergedText}`);
      lines.push(``);
    }
  }

  if (report.llmCallsUsed !== undefined) {
    lines.push(``);
    lines.push(`---`);
    lines.push(`*LLM calls used: ${report.llmCallsUsed}*`);
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
