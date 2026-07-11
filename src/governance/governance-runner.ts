import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDream, type DreamRunResult } from "../dream-engine.js";
import {
  readJsonFile,
  writeJsonAtomic,
  type GovernanceStatusFile,
  type GovernanceStatusSummary,
} from "./run-manifest.js";

export type GovernanceRunStatus = "success" | "failed" | "locked" | "rollback_failed";

export interface GovernanceRunResult {
  status: GovernanceRunStatus;
  runId: string;
  shadow: boolean;
  applied: number;
  manifestPath: string;
  error?: string;
}

export interface GovernanceRunOptions {
  artifactDir?: string;
  lockPath?: string;
  shadow?: boolean;
  trigger?: string;
  runId?: string;
  dreamOptions?: Parameters<typeof runDream>[0];
  runDreamFn?: typeof runDream;
}

const DEFAULT_ARTIFACT_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "memory",
  "autodream-governance",
);

export async function runGovernance(
  options: GovernanceRunOptions = {},
): Promise<GovernanceRunResult> {
  const artifactDir = options.artifactDir ?? DEFAULT_ARTIFACT_DIR;
  const lockPath = options.lockPath ?? path.join(artifactDir, "governance.lock");
  const statusPath = path.join(artifactDir, "governance-status.json");
  const runId = options.runId ?? randomUUID();
  const shadow = options.shadow ?? true;
  const trigger = options.trigger ?? "manual";
  const startedAt = new Date().toISOString();
  const manifestPath = path.join(artifactDir, `run-${runId}.json`);
  await fs.promises.mkdir(artifactDir, { recursive: true });

  let lockHandle: fs.promises.FileHandle;
  try {
    lockHandle = await fs.promises.open(lockPath, "wx");
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, runId, startedAt }));
    await lockHandle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { status: "locked", runId, shadow, applied: 0, manifestPath: "", error: "governance lock is held" };
    }
    throw error;
  }

  try {
    const dreamOptions = {
      ...(options.dreamOptions ?? {}),
      dryRun: shadow,
      autoMergeDuplicates: shadow ? false : options.dreamOptions?.autoMergeDuplicates,
      autoFixTime: shadow ? false : options.dreamOptions?.autoFixTime,
      supersessionApply: shadow ? false : options.dreamOptions?.supersessionApply,
      skipDeep: true,
      skipRem: true,
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ shadow, dreamOptions }))
      .digest("hex");
    let dreamResult: DreamRunResult | undefined;
    let errorMessage: string | undefined;
    try {
      dreamResult = await (options.runDreamFn ?? runDream)(dreamOptions);
      errorMessage = dreamResult.error;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const finishedAt = new Date().toISOString();
    const status: GovernanceRunStatus = errorMessage ? "failed" : "success";
    const applied = shadow
      ? 0
      : dreamResult?.report.supersession?.applied?.count ?? 0;
    const manifest = {
      schemaVersion: 1,
      runId,
      status,
      trigger,
      shadow,
      startedAt,
      finishedAt,
      configFingerprint: fingerprint,
      phaseCounts: {
        scanned: dreamResult?.report.scanned ?? 0,
        duplicateProposals: dreamResult?.report.duplicates.count ?? 0,
        conflictProposals: dreamResult?.report.conflicts.count ?? 0,
        staleProposals: dreamResult?.report.stale.count ?? 0,
        supersessionProposals: dreamResult?.report.supersession?.proposals.length ?? 0,
        applied,
      },
      actions: [],
      skips: shadow ? [{ reason: "shadow_mode", mutations: "disabled" }] : [],
      failures: errorMessage ? [{ phase: "analysis", error: errorMessage }] : [],
      benchmark: {
        activeRecallDelta: 0,
        historyRecallDelta: 0,
        targetedRecallDelta: 0,
      },
      rollback: { attempted: false, status: "not_required" },
    };
    await writeJsonAtomic(manifestPath, manifest);

    const previous = await readJsonFile<GovernanceStatusFile>(statusPath, {
      schemaVersion: 1,
      lastAttempt: null,
      lastSuccess: null,
    });
    const summary: GovernanceStatusSummary = {
      runId,
      status,
      startedAt,
      finishedAt,
      manifestPath,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      lastAttempt: summary,
      lastSuccess: status === "success" ? summary : previous.lastSuccess,
    } satisfies GovernanceStatusFile);

    return { status, runId, shadow, applied, manifestPath, ...(errorMessage ? { error: errorMessage } : {}) };
  } finally {
    await lockHandle.close();
    await fs.promises.rm(lockPath, { force: true });
  }
}
