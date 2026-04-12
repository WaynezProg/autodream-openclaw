import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DreamRunResult } from "./dream-engine.js";

export interface PersistedDreamStatus {
  updatedAt: string;
  lastRun: {
    timestamp: string;
    scanned: number;
    duplicates: number;
    conflicts: number;
    dryRun: boolean;
    warning?: string;
    trigger: "manual" | "scheduled";
    promotions: number;
    reflection: boolean;
  } | null;
  lastDeepPromotion: {
    date: string;
    count: number;
    entries: string[];
    source: "status" | "workspace";
  } | null;
  lastRemReflection: {
    period: string;
    themes: string[];
    source: "status" | "workspace";
  } | null;
}

const STATUS_DIR = path.join(os.homedir(), ".openclaw", "memory", "autodream-reports");
const STATUS_PATH = path.join(STATUS_DIR, "dream-status.json");

const EMPTY_STATUS: PersistedDreamStatus = {
  updatedAt: "",
  lastRun: null,
  lastDeepPromotion: null,
  lastRemReflection: null,
};

export function getStatusFilePath(): string {
  return STATUS_PATH;
}

export async function readPersistedDreamStatus(): Promise<PersistedDreamStatus> {
  try {
    const raw = await fs.promises.readFile(STATUS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedDreamStatus>;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      lastRun: parsed.lastRun ?? null,
      lastDeepPromotion: parsed.lastDeepPromotion ?? null,
      lastRemReflection: parsed.lastRemReflection ?? null,
    };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

export async function writePersistedDreamStatus(
  result: DreamRunResult,
  trigger: "manual" | "scheduled",
): Promise<void> {
  const previous = await readPersistedDreamStatus();
  const report = result.report;

  const next: PersistedDreamStatus = {
    updatedAt: new Date().toISOString(),
    lastRun: {
      timestamp: report.timestamp,
      scanned: report.scanned,
      duplicates: report.duplicates.count,
      conflicts: report.conflicts.count,
      dryRun: report.dryRun,
      warning: result.error,
      trigger,
      promotions: report.promotions?.count ?? 0,
      reflection: Boolean(report.reflection),
    },
    lastDeepPromotion:
      report.promotions && report.promotions.count > 0
        ? {
            date: report.timestamp.slice(0, 10),
            count: report.promotions.count,
            entries: report.promotions.entries.map((entry) => entry.memoryId),
            source: "status",
          }
        : previous.lastDeepPromotion,
    lastRemReflection:
      report.reflection
        ? {
            period: report.reflection.period,
            themes: report.reflection.themes.map((theme) => theme.theme),
            source: "status",
          }
        : previous.lastRemReflection,
  };

  await fs.promises.mkdir(STATUS_DIR, { recursive: true });
  const tmpPath = `${STATUS_PATH}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(next, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, STATUS_PATH);
}
