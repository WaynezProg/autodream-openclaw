import fs from "node:fs";
import path from "node:path";

export interface GovernanceStatusFile {
  schemaVersion: 1;
  lastAttempt: GovernanceStatusSummary | null;
  lastSuccess: GovernanceStatusSummary | null;
}

export interface GovernanceStatusSummary {
  runId: string;
  status: "success" | "failed" | "locked" | "rollback_failed";
  startedAt: string;
  finishedAt: string;
  manifestPath: string;
  error?: string;
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.promises.open(temporaryPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporaryPath, filePath);
}
