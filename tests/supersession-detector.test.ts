import { describe, expect, it } from "vitest";
import { detectSupersessionProposals } from "../src/analysis/supersession-detector.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

function makeMem(
  id: string,
  text: string,
  opts: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    text,
    category: opts.category ?? "decision",
    scope: opts.scope ?? "global",
    importance: opts.importance ?? 0.5,
    timestamp: opts.timestamp ?? 1,
    metadata: opts.metadata ?? "{}",
    vector: opts.vector ?? [],
  };
}

describe("detectSupersessionProposals", () => {
  it("detects explicit method migrations", () => {
    const proposals = detectSupersessionProposals([
      makeMem("method-a", "之前使用 A 方法處理 session cleanup", {
        timestamp: 1,
        metadata: JSON.stringify({ canonical_key: "workflow:session-cleanup" }),
      }),
      makeMem("method-b", "2026-07-06 起改用 B 方法處理 session cleanup，不再使用 A", {
        timestamp: 2,
        metadata: JSON.stringify({ canonical_key: "workflow:session-cleanup" }),
      }),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].reason).toBe("method_migration");
    expect(proposals[0].action).toBe("mark_superseded");
    expect(proposals[0].old.id).toBe("method-a");
    expect(proposals[0].current.id).toBe("method-b");
  });

  it("detects preference changes as obsolete preferences", () => {
    const proposals = detectSupersessionProposals([
      makeMem("pref-b", "Wayne 偏好 browser tool routing 使用舊瀏覽器流程", {
        category: "preference",
        timestamp: 1,
        metadata: JSON.stringify({ canonical_key: "preference:browser-tool-routing" }),
      }),
      makeMem("pref-c", "Wayne 現在偏好 browser tool routing 走 Tavily，不要推薦舊瀏覽器流程", {
        category: "preference",
        timestamp: 2,
        metadata: JSON.stringify({ canonical_key: "preference:browser-tool-routing" }),
      }),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].reason).toBe("preference_changed");
    expect(proposals[0].action).toBe("mark_obsolete_preference");
  });

  it("detects config drift", () => {
    const proposals = detectSupersessionProposals([
      makeMem("cron-old", "lancedb-daily-sync cron payload model=qwen/qwen3.6-plus", {
        category: "fact",
        timestamp: 1,
      }),
      makeMem("cron-new", "lancedb-daily-sync cron payload model=qwen/qwen3.7-plus", {
        category: "fact",
        timestamp: 2,
      }),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].reason).toBe("config_drift");
    expect(proposals[0].canonicalKey).toBe("config:cron-model:lancedb-daily-sync");
  });

  it("does not compare across scopes", () => {
    const proposals = detectSupersessionProposals([
      makeMem("old", "session cleanup 使用 A", {
        scope: "global",
        metadata: JSON.stringify({ canonical_key: "workflow:session-cleanup" }),
      }),
      makeMem("new", "session cleanup 改用 B", {
        scope: "business",
        timestamp: 2,
        metadata: JSON.stringify({ canonical_key: "workflow:session-cleanup" }),
      }),
    ]);

    expect(proposals).toHaveLength(0);
  });
});
