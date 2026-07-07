import type { DedupPair } from "../analysis/dedup-detector.js";
import type { TimeFixEntry } from "../analysis/time-normalizer.js";
import type { ConflictPair } from "../analysis/conflict-detector.js";
import type { StaleEntry } from "../analysis/staleness-scorer.js";
import type { MemoryRecord } from "../lancedb-adapter.js";
import type { MergeResult } from "../analysis/dedup-merger.js";
import type { DeepPromotionResult } from "../analysis/deep-promoter.js";
import type { RemReflection } from "../analysis/rem-reflector.js";
import type { SupersessionProposal } from "../analysis/supersession-detector.js";
import type { SupersessionApplyResult } from "../analysis/supersession-applier.js";

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
  supersession: {
    count: number;
    proposals: Array<{
      old: { id: string; text: string };
      current: { id: string; text: string };
      canonicalKey: string;
      reason: string;
      confidence: string;
      action: string;
      evidence: string[];
    }>;
    applied?: {
      count: number;
      skipped: number;
      errors: number;
      entries: Array<{
        oldId: string;
        currentId: string;
        reason: string;
        action: string;
      }>;
    };
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
  promotions?: {
    count: number;
    entries: Array<{
      memoryId: string;
      score: number;
      refinedText: string;
    }>;
  };
  reflection?: {
    period: string;
    themes: Array<{ theme: string; queryCount: number; strength: number }>;
    summary: string;
  };
  noiseDeleted?: number;
  noiseEntries?: Array<{ id: string; text: string }>;
  reEmbedded?: number;
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
  promotionResult?: DeepPromotionResult,
  reflection?: RemReflection | null,
  noiseDeleted?: number,
  reEmbedded?: number,
  noiseMemories?: MemoryRecord[],
  supersessionProposals: SupersessionProposal[] = [],
  supersessionApplyResult?: SupersessionApplyResult,
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
    supersession: {
      count: supersessionProposals.length,
      proposals: supersessionProposals.map((p) => ({
        old: { id: p.old.id, text: truncate(p.old.text, 120) },
        current: { id: p.current.id, text: truncate(p.current.text, 120) },
        canonicalKey: p.canonicalKey,
        reason: p.reason,
        confidence: p.confidence,
        action: p.action,
        evidence: p.evidence,
      })),
      applied: supersessionApplyResult
        ? {
            count: supersessionApplyResult.applied,
            skipped: supersessionApplyResult.skipped,
            errors: supersessionApplyResult.errors.length,
            entries: supersessionApplyResult.entries.map((e) => ({
              oldId: e.oldId,
              currentId: e.currentId,
              reason: e.reason,
              action: e.action,
            })),
          }
        : undefined,
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
    noiseDeleted: noiseDeleted ?? 0,
    noiseEntries:
      noiseMemories && noiseMemories.length > 0
        ? noiseMemories.slice(0, 5).map((m) => ({
            id: m.id.slice(0, 8),
            text: truncate(m.text, 80),
          }))
        : undefined,
    reEmbedded: reEmbedded ?? 0,
    promotions:
      promotionResult && promotionResult.count > 0
        ? {
            count: promotionResult.count,
            entries: promotionResult.entries.map((e) => ({
              memoryId: e.memoryId,
              score: round(e.score, 4),
              refinedText: truncate(e.refinedText, 200),
            })),
          }
        : undefined,
    reflection:
      reflection
        ? {
            period: reflection.period,
            themes: reflection.themes.map((t) => ({
              theme: t.theme,
              queryCount: t.queryCount,
              strength: round(t.strength, 4),
            })),
            summary: reflection.summary,
          }
        : undefined,
    dryRun,
  };
}

export function formatReportMarkdown(report: DreamReport): string {
  const supersession = report.supersession ?? {
    count: 0,
    proposals: [],
    applied: undefined,
  };
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

  lines.push(`## Supersession Proposals (${supersession.count})`);
  lines.push(``);
  if (supersession.proposals.length === 0) {
    lines.push("No supersession proposals found.");
  } else {
    for (const proposal of supersession.proposals) {
      lines.push(
        `- [${proposal.confidence}] ${proposal.reason} ${proposal.canonicalKey}`,
      );
      lines.push(`  - old: \`${proposal.old.id}\` — ${proposal.old.text}`);
      lines.push(`  - current: \`${proposal.current.id}\` — ${proposal.current.text}`);
      lines.push(`  - action: ${proposal.action}`);
      if (proposal.evidence.length > 0) {
        lines.push(`  - evidence: ${proposal.evidence.join("; ")}`);
      }
      lines.push(``);
    }
  }

  if (supersession.applied) {
    lines.push(
      `Applied: ${supersession.applied.count}, skipped: ${supersession.applied.skipped}, errors: ${supersession.applied.errors}`,
    );
    lines.push(``);
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

  if (report.promotions && report.promotions.count > 0) {
    lines.push(``);
    lines.push(`## Deep Promotions (${report.promotions.count})`);
    lines.push(``);
    for (const entry of report.promotions.entries) {
      lines.push(
        `- \`${entry.memoryId}\` — score: **${entry.score.toFixed(4)}**`,
      );
      lines.push(`  ${entry.refinedText}`);
      lines.push(``);
    }
  }

  if (report.reflection) {
    lines.push(``);
    lines.push(`## REM Reflection (${report.reflection.period})`);
    lines.push(``);
    if (report.reflection.themes.length > 0) {
      const themeStr = report.reflection.themes
        .map((t) => `${t.theme} (${t.queryCount}次)`)
        .join(", ");
      lines.push(`**Themes:** ${themeStr}`);
      lines.push(``);
    }
    if (report.reflection.summary) {
      lines.push(`> ${report.reflection.summary}`);
      lines.push(``);
    }
  }

  if (report.reEmbedded && report.reEmbedded > 0) {
    lines.push(``);
    lines.push(`*Re-embedded: ${report.reEmbedded} memories*`);
  }

  if (report.noiseDeleted && report.noiseDeleted > 0) {
    lines.push(``);
    lines.push(
      `### Noise Deleted (${report.noiseDeleted})${report.dryRun ? " (would delete)" : ""}`,
    );
    lines.push(``);
    if (report.noiseEntries && report.noiseEntries.length > 0) {
      for (const entry of report.noiseEntries) {
        lines.push(`- \`${entry.id}\` ${entry.text}`);
      }
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

/**
 * Format a compact report listing only items with actual changes.
 * Used for notifications and daily notes.
 */
export function formatCompactReport(report: DreamReport): string | null {
  const supersession = report.supersession ?? {
    count: 0,
    proposals: [],
    applied: undefined,
  };
  const lines: string[] = [];

  if (report.merges && report.merges.count > 0) {
    lines.push(`- Duplicates merged: ${report.merges.count}`);
  } else if (report.duplicates.count > 0) {
    lines.push(`- Duplicates found: ${report.duplicates.count}`);
  }

  if (report.timeFixesApplied && report.timeFixesApplied > 0) {
    lines.push(`- Time expressions fixed: ${report.timeFixesApplied}`);
  }

  if (report.noiseDeleted && report.noiseDeleted > 0) {
    lines.push(`- Noise deleted: ${report.noiseDeleted}`);
  }

  if (report.conflicts.count > 0) {
    lines.push(`- Conflicts detected: ${report.conflicts.count}`);
  }

  if (supersession.count > 0) {
    lines.push(`- Supersession proposals: ${supersession.count}`);
  }

  if (supersession.applied && supersession.applied.count > 0) {
    lines.push(`- Supersession applied: ${supersession.applied.count}`);
  }

  if (report.promotions && report.promotions.count > 0) {
    lines.push(`- Deep promotions: ${report.promotions.count}`);
  }

  if (report.reEmbedded && report.reEmbedded > 0) {
    lines.push(`- Re-embedded: ${report.reEmbedded}`);
  }

  if (report.reflection) {
    lines.push(`- REM reflection: ${report.reflection.themes.length} themes`);
  }

  if (lines.length === 0) {
    return null;
  }

  const header = `🧠 autoDream Report (${report.scanned} scanned${report.dryRun ? ", dry-run" : ""})`;
  return `${header}\n${lines.join("\n")}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
