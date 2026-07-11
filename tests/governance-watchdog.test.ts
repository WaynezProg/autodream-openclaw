import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error The watchdog is intentionally a directly executable MJS script.
import { checkGovernanceHealth } from "../scripts/governance-watchdog.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autodream-watchdog-"));
}

describe("governance watchdog", () => {
  it("accepts a recent successful shadow run", async () => {
    const dir = tempDir();
    const now = Date.parse("2026-07-12T02:00:00.000Z");
    fs.writeFileSync(path.join(dir, "governance-status.json"), JSON.stringify({
      schemaVersion: 1,
      lastAttempt: { runId: "ok", status: "success" },
      lastSuccess: { runId: "ok", status: "success", finishedAt: new Date(now - 60_000).toISOString() },
    }));

    const result = await checkGovernanceHealth({ artifactDir: dir, now });

    expect(result.ok).toBe(true);
    expect(result.rolloutEligible).toBe(false);
    expect(result.alerts).toEqual([]);
  });

  it("alerts after 26 hours without success", async () => {
    const dir = tempDir();
    const now = Date.parse("2026-07-12T02:00:00.000Z");
    fs.writeFileSync(path.join(dir, "governance-status.json"), JSON.stringify({
      schemaVersion: 1,
      lastAttempt: { runId: "old", status: "success" },
      lastSuccess: { runId: "old", status: "success", finishedAt: new Date(now - 27 * 3_600_000).toISOString() },
    }));

    const result = await checkGovernanceHealth({ artifactDir: dir, now });

    expect(result.ok).toBe(false);
    expect(result.alerts.join(" ")).toContain("26 hours");
  });

  it("alerts on a stale governance lock", async () => {
    const dir = tempDir();
    const now = Date.parse("2026-07-12T02:00:00.000Z");
    fs.writeFileSync(path.join(dir, "governance-status.json"), JSON.stringify({
      schemaVersion: 1,
      lastAttempt: null,
      lastSuccess: { runId: "ok", status: "success", finishedAt: new Date(now - 60_000).toISOString() },
    }));
    fs.writeFileSync(path.join(dir, "governance.lock"), JSON.stringify({
      pid: 999999,
      runId: "stale",
      startedAt: new Date(now - 3 * 3_600_000).toISOString(),
    }));

    const result = await checkGovernanceHealth({ artifactDir: dir, now });

    expect(result.ok).toBe(false);
    expect(result.alerts.join(" ")).toContain("stale lock");
  });

  it("alerts on a corrupt governance lock", async () => {
    const dir = tempDir();
    const now = Date.parse("2026-07-12T02:00:00.000Z");
    fs.writeFileSync(path.join(dir, "governance-status.json"), JSON.stringify({
      schemaVersion: 1,
      lastAttempt: null,
      lastSuccess: { runId: "ok", status: "success", finishedAt: new Date(now - 60_000).toISOString() },
    }));
    fs.writeFileSync(path.join(dir, "governance.lock"), "{");
    const result = await checkGovernanceHealth({ artifactDir: dir, now });
    expect(result.alerts.join(" ")).toContain("corrupt");
  });
});
