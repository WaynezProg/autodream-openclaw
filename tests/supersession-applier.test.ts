import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LanceDbAdapter, parseMetadata, type MemoryRecord } from "../src/lancedb-adapter.js";
import { applySupersessionProposals } from "../src/analysis/supersession-applier.js";
import type { SupersessionProposal } from "../src/analysis/supersession-detector.js";
import * as lancedb from "@lancedb/lancedb";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeMem(id: string, text: string, opts?: Partial<{ metadata: string; scope: string; category: string; importance: number; timestamp: number }>) {
  return {
    id,
    text,
    metadata: opts?.metadata ?? "{}",
    scope: opts?.scope ?? "global",
    category: opts?.category ?? "fact",
    importance: opts?.importance ?? 0.5,
    timestamp: opts?.timestamp ?? Date.now(),
    vector: [0.1, 0.2, 0.3, 0.4, 0.5],
  };
}

describe("LanceDbAdapter.updateMemoryMetadata", () => {
  let tmpDir: string;
  let adapter: LanceDbAdapter;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-supersession-test-"));
    // Create table via raw LanceDB API first
    const db = await lancedb.connect(tmpDir);
    await db.createTable("test_memories", [
      makeMem("old-a", "之前使用 A 方法處理 session cleanup", {
        metadata: JSON.stringify({ state: "confirmed", canonical_key: "workflow:session-cleanup" }),
      }),
      makeMem("new-b", "2026-07-06 起改用 B 方法處理 session cleanup", {
        metadata: JSON.stringify({ state: "confirmed", canonical_key: "workflow:session-cleanup" }),
      }),
    ]);
    adapter = new LanceDbAdapter({ dbPath: tmpDir, tableName: "test_memories" });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should parse supersession metadata fields", () => {
    const raw = JSON.stringify({
      state: "superseded",
      valid_from: 1000,
      valid_until: 2000,
      supersedes: ["old-id"],
      superseded_by: "new-id",
      supersession_reason: "method_migration",
      canonical_key: "workflow:session-cleanup",
    });
    const parsed = parseMetadata(raw);
    expect(parsed.state).toBe("superseded");
    expect(parsed.valid_from).toBe(1000);
    expect(parsed.valid_until).toBe(2000);
    expect(parsed.supersedes).toEqual(["old-id"]);
    expect(parsed.superseded_by).toBe("new-id");
    expect(parsed.supersession_reason).toBe("method_migration");
    expect(parsed.canonical_key).toBe("workflow:session-cleanup");
  });

  it("should update metadata of a memory by id", async () => {
    await adapter.updateMemoryMetadata("old-a", {
      state: "superseded",
      invalidated_at: Date.now(),
      superseded_by: "new-b",
      supersession_reason: "method_migration",
    });

    // Read back and verify
    const all = await adapter.listAllMemories();
    const oldMem = all.find(m => m.id === "old-a");
    expect(oldMem).toBeDefined();
    const meta = parseMetadata(oldMem!.metadata);
    expect(meta.state).toBe("superseded");
    expect(meta.superseded_by).toBe("new-b");
    expect(meta.supersession_reason).toBe("method_migration");
    expect(meta.invalidated_at).toBeDefined();
    // Original fields preserved
    expect(meta.canonical_key).toBe("workflow:session-cleanup");
  });

  it("should merge metadata patch without losing existing fields", async () => {
    await adapter.updateMemoryMetadata("old-a", {
      state: "superseded",
    });
    const all = await adapter.listAllMemories();
    const oldMem = all.find(m => m.id === "old-a");
    const meta = parseMetadata(oldMem!.metadata);
    expect(meta.state).toBe("superseded");
    expect(meta.canonical_key).toBe("workflow:session-cleanup"); // preserved
  });

  it("should throw if memory not found", async () => {
    await expect(
      adapter.updateMemoryMetadata("nonexistent", { state: "superseded" })
    ).rejects.toThrow("Memory not found");
  });
});

describe("applySupersessionProposals", () => {
  it("applies high confidence metadata-only changes", async () => {
    const adapter = makeAdapter();
    const proposal = makeProposal();

    const result = await applySupersessionProposals(adapter, [proposal], {
      maxChanges: 10,
      now: 1234,
    });

    expect(result.applied).toBe(1);
    expect(adapter.updateMemoryMetadata).toHaveBeenCalledTimes(2);
    expect(adapter.updateMemoryMetadata).toHaveBeenCalledWith("old-a", {
      state: "superseded",
      invalidated_at: 1234,
      superseded_by: "new-b",
      supersession_reason: "method_migration",
      canonical_key: "workflow:session-cleanup",
    });
    expect(adapter.updateMemoryMetadata).toHaveBeenCalledWith("new-b", {
      state: "confirmed",
      supersedes: ["old-a"],
      canonical_key: "workflow:session-cleanup",
    });
  });

  it("marks changed preferences as obsolete_preference", async () => {
    const adapter = makeAdapter();
    const proposal = makeProposal({
      reason: "preference_changed",
      action: "mark_obsolete_preference",
    });

    await applySupersessionProposals(adapter, [proposal], {
      maxChanges: 10,
      now: 1234,
    });

    expect(adapter.updateMemoryMetadata).toHaveBeenCalledWith(
      "old-a",
      expect.objectContaining({ state: "obsolete_preference" }),
    );
  });

  it("skips low confidence, flag_conflict, and proposals beyond maxChanges", async () => {
    const adapter = makeAdapter();
    const proposals = [
      makeProposal({ old: makeRecord("old-1"), current: makeRecord("new-1") }),
      makeProposal({
        old: makeRecord("old-2"),
        current: makeRecord("new-2"),
        confidence: "low",
      }),
      makeProposal({
        old: makeRecord("old-3"),
        current: makeRecord("new-3"),
        action: "flag_conflict",
      }),
      makeProposal({ old: makeRecord("old-4"), current: makeRecord("new-4") }),
    ];

    const result = await applySupersessionProposals(adapter, proposals, {
      maxChanges: 1,
      now: 1234,
    });

    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(3);
    expect(adapter.updateMemoryMetadata).toHaveBeenCalledTimes(2);
    expect(adapter.updateMemoryMetadata).toHaveBeenCalledWith(
      "old-1",
      expect.any(Object),
    );
  });

  it("protects every core memory from automatic mutation", async () => {
    const adapter = makeAdapter();
    const coreMethod = makeProposal({
      old: makeRecord("core-old", {
        importance: 0.9,
        metadata: JSON.stringify({ tier: "core" }),
      }),
      current: makeRecord("method-new", { importance: 0.95 }),
      reason: "method_migration",
    });
    const corePreference = makeProposal({
      old: makeRecord("pref-old", {
        importance: 0.7,
        metadata: JSON.stringify({ tier: "core" }),
      }),
      current: makeRecord("pref-new", { importance: 0.8 }),
      reason: "preference_changed",
      action: "mark_obsolete_preference",
    });

    const result = await applySupersessionProposals(
      adapter,
      [coreMethod, corePreference],
      { maxChanges: 10, now: 1234 },
    );

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(2);
    expect(adapter.updateMemoryMetadata).not.toHaveBeenCalledWith(
      "core-old",
      expect.any(Object),
    );
    expect(adapter.updateMemoryMetadata).not.toHaveBeenCalledWith(
      "pref-old",
      expect.any(Object),
    );
  });

  it("rolls both rows back when the second update fails", async () => {
    const adapter = makeAdapter();
    adapter.updateMemoryMetadata
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("second update failed"));

    const result = await applySupersessionProposals(adapter, [makeProposal()], {
      maxChanges: 10,
      now: 1234,
    });

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(adapter.replaceMemoryMetadata).toHaveBeenCalledWith("old-a", "{}");
    expect(adapter.replaceMemoryMetadata).toHaveBeenCalledWith(
      "new-b",
      JSON.stringify({ supersedes: [] }),
    );
  });
});

function makeAdapter() {
  const rows = new Map<string, MemoryRecord>([
    ["old-a", makeRecord("old-a")],
    ["new-b", makeRecord("new-b", {
      timestamp: 2,
      metadata: JSON.stringify({ supersedes: [] }),
    })],
    ["old-1", makeRecord("old-1")],
    ["new-1", makeRecord("new-1")],
    ["old-2", makeRecord("old-2")],
    ["new-2", makeRecord("new-2")],
    ["old-3", makeRecord("old-3")],
    ["new-3", makeRecord("new-3")],
    ["old-4", makeRecord("old-4")],
    ["new-4", makeRecord("new-4")],
    ["core-old", makeRecord("core-old", { metadata: JSON.stringify({ tier: "core" }) })],
    ["method-new", makeRecord("method-new")],
    ["pref-old", makeRecord("pref-old", { metadata: JSON.stringify({ tier: "core" }) })],
    ["pref-new", makeRecord("pref-new")],
  ]);
  const updateMemoryMetadata = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (!row) return false;
    row.metadata = JSON.stringify({ ...parseMetadata(row.metadata), ...patch });
    return true;
  });
  const replaceMemoryMetadata = vi.fn(async (id: string, metadata: string) => {
    const row = rows.get(id);
    if (!row) return false;
    row.metadata = metadata;
    return true;
  });
  return {
    updateMemoryMetadata,
    replaceMemoryMetadata,
    getMemoryById: vi.fn(async (id: string) => rows.get(id) ?? null),
  };
}

function makeRecord(id: string, opts: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text: opts.text ?? `${id} text`,
    category: opts.category ?? "decision",
    scope: opts.scope ?? "global",
    importance: opts.importance ?? 0.5,
    timestamp: opts.timestamp ?? 1,
    metadata: opts.metadata ?? "{}",
    vector: opts.vector ?? [],
  };
}

function makeProposal(
  opts: Partial<SupersessionProposal> = {},
): SupersessionProposal {
  return {
    old: opts.old ?? makeRecord("old-a"),
    current:
      opts.current ??
      makeRecord("new-b", {
        metadata: JSON.stringify({ supersedes: [] }),
        timestamp: 2,
      }),
    canonicalKey: opts.canonicalKey ?? "workflow:session-cleanup",
    reason: opts.reason ?? "method_migration",
    confidence: opts.confidence ?? "high",
    evidence: opts.evidence ?? ["test"],
    action: opts.action ?? "mark_superseded",
  };
}
