import { describe, expect, it } from "vitest";
import { deriveCanonicalKey } from "../src/analysis/canonical-key.js";
import type { MemoryRecord } from "../src/lancedb-adapter.js";

function makeMem(text: string, metadata = "{}"): MemoryRecord {
  return {
    id: "mem",
    text,
    category: "decision",
    scope: "global",
    importance: 0.5,
    timestamp: 1,
    metadata,
    vector: [],
  };
}

describe("deriveCanonicalKey", () => {
  it("prefers metadata canonical_key", () => {
    expect(
      deriveCanonicalKey(
        makeMem("anything", JSON.stringify({ canonical_key: "workflow:session-cleanup" })),
      ),
    ).toBe("workflow:session-cleanup");
  });

  it("extracts cron model config keys with context", () => {
    expect(
      deriveCanonicalKey(
        makeMem("lancedb-daily-sync cron payload model=qwen/qwen3.7-plus"),
      ),
    ).toBe("config:cron-model:lancedb-daily-sync");
  });

  it("extracts known preference topics", () => {
    expect(
      deriveCanonicalKey(
        makeMem("Wayne 現在偏好 browser tool routing 走 Tavily，不要推薦舊瀏覽器流程"),
      ),
    ).toBe("preference:browser-tool-routing");
  });

  it("extracts known workflow topics", () => {
    expect(deriveCanonicalKey(makeMem("session cleanup 流程改用新的 cron"))).toBe(
      "workflow:session-cleanup",
    );
  });

  it("does not return over-broad keys", () => {
    expect(deriveCanonicalKey(makeMem("model=qwen/qwen3.7-plus"))).toBeNull();
    expect(deriveCanonicalKey(makeMem("cron 每天跑"))).toBeNull();
  });
});
