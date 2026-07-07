import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LanceDbAdapter, parseMetadata } from "../src/lancedb-adapter.js";
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
      supersedes: "old-id",
      superseded_by: "new-id",
      supersession_reason: "method_migration",
      canonical_key: "workflow:session-cleanup",
    });
    const parsed = parseMetadata(raw);
    expect(parsed.state).toBe("superseded");
    expect(parsed.valid_from).toBe(1000);
    expect(parsed.valid_until).toBe(2000);
    expect(parsed.supersedes).toBe("old-id");
    expect(parsed.superseded_by).toBe("new-id");
    expect(parsed.supersession_reason).toBe("method_migration");
    expect(parsed.canonical_key).toBe("workflow:session-cleanup");
  });

  it("should update metadata of a memory by id", async () => {
    await adapter.updateMemoryMetadata("old-a", {
      state: "superseded",
      valid_until: Date.now(),
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
    expect(meta.valid_until).toBeDefined();
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
