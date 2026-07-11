import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGovernance } from "../src/governance/governance-runner.js";

function fakeDreamResult(error?: string) {
  return {
    report: {
      timestamp: "2026-07-12T00:20:00.000Z",
      scanned: 12,
      duplicates: { count: 1, pairs: [] },
      conflicts: { count: 0, pairs: [] },
      stale: { count: 2, entries: [] },
      timeIssues: { count: 0, entries: [] },
      dryRun: true,
      noiseDeleted: 0,
      supersession: { proposals: [], applied: 0, skipped: 0, errors: [] },
    },
    error,
  } as any;
}

describe("runGovernance", () => {
  it("writes a successful shadow manifest and last-success status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodream-governance-"));
    const result = await runGovernance({
      artifactDir: dir,
      lockPath: path.join(dir, "governance.lock"),
      shadow: true,
      trigger: "test",
      runId: "run-success",
      runDreamFn: vi.fn().mockResolvedValue(fakeDreamResult()),
    });

    expect(result).toMatchObject({
      status: "success",
      runId: "run-success",
      shadow: true,
      applied: 0,
    });
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    const status = JSON.parse(fs.readFileSync(path.join(dir, "governance-status.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.phaseCounts.scanned).toBe(12);
    expect(manifest.actions).toEqual([]);
    expect(status.lastAttempt.runId).toBe("run-success");
    expect(status.lastSuccess.runId).toBe("run-success");
    expect(fs.existsSync(path.join(dir, "governance.lock"))).toBe(false);
  });

  it("fails closed when another process holds the lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodream-governance-lock-"));
    const lockPath = path.join(dir, "governance.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, runId: "active" }));
    const runDreamFn = vi.fn();

    const result = await runGovernance({
      artifactDir: dir,
      lockPath,
      shadow: true,
      trigger: "test",
      runId: "run-locked",
      runDreamFn,
    });

    expect(result.status).toBe("locked");
    expect(result.applied).toBe(0);
    expect(runDreamFn).not.toHaveBeenCalled();
  });

  it("records failure and never advances lastSuccess", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodream-governance-fail-"));
    const result = await runGovernance({
      artifactDir: dir,
      lockPath: path.join(dir, "governance.lock"),
      shadow: true,
      trigger: "test",
      runId: "run-failed",
      runDreamFn: vi.fn().mockResolvedValue(fakeDreamResult("schema mismatch")),
    });

    expect(result.status).toBe("failed");
    expect(result.applied).toBe(0);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "governance-status.json"), "utf8"));
    expect(status.lastAttempt.runId).toBe("run-failed");
    expect(status.lastSuccess).toBeNull();
  });

  it("is mutation-idempotent across repeated shadow runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodream-governance-repeat-"));
    const runDreamFn = vi.fn().mockResolvedValue(fakeDreamResult());
    const first = await runGovernance({
      artifactDir: dir,
      lockPath: path.join(dir, "governance.lock"),
      shadow: true,
      trigger: "test",
      runId: "run-one",
      runDreamFn,
    });
    const second = await runGovernance({
      artifactDir: dir,
      lockPath: path.join(dir, "governance.lock"),
      shadow: true,
      trigger: "test",
      runId: "run-two",
      runDreamFn,
    });

    expect(first.applied).toBe(0);
    expect(second.applied).toBe(0);
    expect(runDreamFn).toHaveBeenNthCalledWith(1, expect.objectContaining({ dryRun: true }));
    expect(runDreamFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ dryRun: true }));
  });
});
