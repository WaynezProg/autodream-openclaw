#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const TAG_CATEGORY = new Map([
  ["decision", "decision"],
  ["lesson", "fact"],
  ["bug", "fact"],
  ["info", "fact"],
]);

function previousDate(date) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() - 1);
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

async function matchingFiles(dir, dates) {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        dates.some((date) => entry.name.startsWith(date)),
      )
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function recordsFromFile(filePath, scope, openclawDir) {
  const relativePath = path.relative(openclawDir, filePath);
  const sourceDate = path.basename(filePath).slice(0, 10);
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*[-*]\s+#(decision|lesson|bug|info)\b\s*(.+)$/i);
    if (!match) return [];
    const tag = match[1].toLowerCase();
    const text = `#${tag} ${match[2].trim()}`;
    if (text.length < 12 || text.length > 4000) return [];
    const id = createHash("sha256")
      .update(`${scope}\0${relativePath}\0${text}`)
      .digest("hex");
    return [{
      scope,
      memory: {
        id,
        text,
        category: TAG_CATEGORY.get(tag),
        importance: tag === "decision" || tag === "bug" ? 0.8 : 0.65,
        timestamp: Date.parse(`${sourceDate}T00:00:00`),
        metadata: {
          state: "confirmed",
          source: "daily-note-ingest",
          source_path: relativePath,
          source_date: sourceDate,
          source_tag: tag,
        },
      },
    }];
  });
}

export async function collectDailyNotes({
  openclawDir = path.join(os.homedir(), ".openclaw"),
  date = new Date().toLocaleDateString("en-CA"),
} = {}) {
  const dates = [previousDate(date), date];
  const workspace = path.join(openclawDir, "workspace");
  const sources = [];
  for (const filePath of await matchingFiles(path.join(workspace, "memory"), dates)) {
    sources.push({ filePath, scope: "global" });
  }
  const agentsDir = path.join(workspace, "agents");
  let agents = [];
  try {
    agents = (await fs.promises.readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const agent of agents) {
    for (const filePath of await matchingFiles(path.join(agentsDir, agent, "memory"), dates)) {
      sources.push({ filePath, scope: `agent:${agent}` });
    }
  }
  return sources.flatMap(({ filePath, scope }) =>
    recordsFromFile(filePath, scope, openclawDir),
  );
}

async function runOpenClaw(args) {
  return execFileAsync("openclaw", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function writeImportFile(memories) {
  const filePath = path.join(os.tmpdir(), `openclaw-daily-note-${randomUUID()}.json`);
  await fs.promises.writeFile(filePath, `${JSON.stringify({ memories })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

async function backup(openclawDir, date) {
  const backupDir = path.join(openclawDir, "memory", "backups");
  await fs.promises.mkdir(backupDir, { recursive: true });
  const output = path.join(backupDir, `memory-backup-${date}.json`);
  await runOpenClaw(["memory-pro", "export", "--output", output]);
  const stat = await fs.promises.stat(output);
  if (!stat.isFile() || stat.size === 0) throw new Error("memory backup verification failed");
  const cutoff = Date.now() - 3 * 86_400_000;
  for (const entry of await fs.promises.readdir(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^memory-backup-\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
    const candidate = path.join(backupDir, entry.name);
    if ((await fs.promises.stat(candidate)).mtimeMs < cutoff) {
      await fs.promises.rm(candidate);
    }
  }
  return output;
}

export async function runDailyIngest(options = {}) {
  const openclawDir = options.openclawDir ?? path.join(os.homedir(), ".openclaw");
  const date = options.date ?? new Date().toLocaleDateString("en-CA");
  const backupPath = await backup(openclawDir, date);
  const entries = await collectDailyNotes({ openclawDir, date });
  const groups = Map.groupBy(entries, (entry) => entry.scope);
  const imports = [];
  for (const [scope, scopedEntries] of groups) {
    const filePath = await writeImportFile(scopedEntries.map((entry) => entry.memory));
    try {
      const { stdout } = await runOpenClaw(["memory-pro", "import", filePath, "--scope", scope]);
      imports.push({ scope, candidates: scopedEntries.length, output: stdout.trim() });
    } finally {
      await fs.promises.rm(filePath, { force: true });
    }
  }
  const { stdout: statsOutput } = await runOpenClaw(["memory-pro", "stats", "--json"]);
  const stats = JSON.parse(statsOutput.slice(statsOutput.indexOf("{"), statsOutput.lastIndexOf("}") + 1));
  return { status: "success", date, backupPath, candidates: entries.length, imports, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runDailyIngest())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
