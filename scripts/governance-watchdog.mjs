#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOUR_MS = 3_600_000;

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function checkGovernanceHealth({
  artifactDir = path.join(os.homedir(), ".openclaw", "memory", "autodream-governance"),
  now = Date.now(),
  maxSuccessAgeMs = 26 * HOUR_MS,
  staleLockAgeMs = 2 * HOUR_MS,
} = {}) {
  const alerts = [];
  const statusPath = path.join(artifactDir, "governance-status.json");
  const lockPath = path.join(artifactDir, "governance.lock");
  const status = await readJson(statusPath);

  if (!status?.lastSuccess?.finishedAt) {
    alerts.push("no successful governance run is recorded");
  } else {
    const successAge = now - Date.parse(status.lastSuccess.finishedAt);
    if (!Number.isFinite(successAge) || successAge > maxSuccessAgeMs) {
      alerts.push("no successful governance run within 26 hours");
    }
  }

  if (status?.lastAttempt?.status === "rollback_failed") {
    alerts.push(`rollback failed in run ${status.lastAttempt.runId ?? "unknown"}`);
  }

  const lock = await readJson(lockPath);
  const lockExists = await fs.promises.stat(lockPath).then(() => true, () => false);
  if (lockExists && !lock) {
    alerts.push("governance lock is corrupt");
  } else if (lock) {
    const lockAge = now - Date.parse(lock.startedAt ?? "");
    if (!Number.isFinite(lockAge) || lockAge > staleLockAgeMs) {
      alerts.push(`stale lock for run ${lock.runId ?? "unknown"}`);
    }
  }

  const manifest = status?.lastSuccess?.manifestPath
    ? await readJson(status.lastSuccess.manifestPath)
    : null;
  const benchmark = manifest?.benchmark;
  if (
    benchmark &&
    [benchmark.activeRecallDelta, benchmark.historyRecallDelta, benchmark.targetedRecallDelta]
      .some((value) => typeof value === "number" && value < 0)
  ) {
    alerts.push(`recall benchmark regressed in run ${manifest.runId ?? "unknown"}`);
  }

  return {
    ok: alerts.length === 0,
    checkedAt: new Date(now).toISOString(),
    lastSuccessRunId: status?.lastSuccess?.runId ?? null,
    rolloutEligible:
      manifest?.rolloutEligible === true && manifest?.benchmark?.status === "passed",
    alerts,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkGovernanceHealth();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
