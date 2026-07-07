import { describe, expect, it } from "vitest";
import { buildReport, formatCompactReport, formatReportMarkdown } from "../src/report/reporter.js";
import type { SupersessionProposal } from "../src/analysis/supersession-detector.js";

const proposal: SupersessionProposal = {
  old: {
    id: "old-a",
    text: "previously used A",
    category: "decision",
    scope: "global",
    importance: 0.5,
    timestamp: 1,
    metadata: "{}",
    vector: [],
  },
  current: {
    id: "new-b",
    text: "now use B",
    category: "decision",
    scope: "global",
    importance: 0.7,
    timestamp: 2,
    metadata: "{}",
    vector: [],
  },
  canonicalKey: "workflow:session-cleanup",
  reason: "method_migration",
  confidence: "high",
  evidence: ["newer memory contains migration signal"],
  action: "mark_superseded",
};

describe("reporter supersession section", () => {
  it("formats supersession proposals in markdown", () => {
    const report = buildReport(2, [], [], [], [], true, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [proposal]);

    const markdown = formatReportMarkdown(report);

    expect(markdown).toContain("## Supersession Proposals (1)");
    expect(markdown).toContain("[high] method_migration workflow:session-cleanup");
    expect(markdown).toContain("old: `old-a`");
    expect(markdown).toContain("current: `new-b`");
    expect(markdown).toContain("action: mark_superseded");
  });

  it("includes apply counts and compact summary", () => {
    const report = buildReport(
      2,
      [],
      [],
      [],
      [],
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [proposal],
      {
        applied: 1,
        skipped: 0,
        errors: [],
        entries: [
          {
            oldId: "old-a",
            currentId: "new-b",
            reason: "method_migration",
            action: "mark_superseded",
          },
        ],
      },
    );

    expect(formatReportMarkdown(report)).toContain("Applied: 1, skipped: 0, errors: 0");
    expect(formatCompactReport(report)).toContain("Supersession applied: 1");
  });
});
