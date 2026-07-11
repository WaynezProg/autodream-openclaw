import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDailyNotes,
  parseImportOutput,
  parseJsonOutput,
  verifyBackupCoverage,
} from "../scripts/daily-note-ingest.mjs";

describe("collectDailyNotes", () => {
  it("collects only tagged durable bullets from today and yesterday with stable ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-note-ingest-"));
    const globalDir = path.join(root, "workspace", "memory");
    const agentDir = path.join(root, "workspace", "agents", "yor", "memory");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "2026-07-12.md"), [
      "- #decision use deterministic ingestion",
      "- untagged transient note",
      "- #todo do not persist this",
    ].join("\n"));
    fs.writeFileSync(path.join(agentDir, "2026-07-11.md"), "- #bug old CSV was wrong\n");
    fs.writeFileSync(path.join(agentDir, "2026-07-10.md"), "- #info outside the window\n");

    const first = await collectDailyNotes({ openclawDir: root, date: "2026-07-12" });
    const second = await collectDailyNotes({ openclawDir: root, date: "2026-07-12" });

    expect(first).toHaveLength(2);
    expect(first.map((entry) => entry.scope)).toEqual(["global", "agent:yor"]);
    expect(first.map((entry) => entry.memory.category)).toEqual(["decision", "fact"]);
    expect(first.map((entry) => entry.memory.id)).toEqual(second.map((entry) => entry.memory.id));
    expect(first.some((entry) => entry.memory.text.includes("#todo"))).toBe(false);
  });
});

describe("parseJsonOutput", () => {
  it("parses JSON emitted after plugin diagnostics", () => {
    expect(parseJsonOutput("[plugins] loaded\n{\"memory\":{\"totalCount\":3}}\n"))
      .toEqual({ memory: { totalCount: 3 } });
  });
});

describe("parseImportOutput", () => {
  it("extracts counts without retaining plugin diagnostics", () => {
    expect(parseImportOutput("[plugins] loaded\nImport completed: 0 imported, 4 skipped, 0 failed\n"))
      .toEqual({ imported: 0, skipped: 4, failed: 0 });
  });
});

describe("verifyBackupCoverage", () => {
  it("checks the pre-import baseline rather than a later total", () => {
    expect(() => verifyBackupCoverage({ count: 2, memories: [{}, {}] }, 2)).not.toThrow();
    expect(() => verifyBackupCoverage({ count: 2, memories: [{}, {}] }, 3))
      .toThrow(/incomplete/);
  });
});
