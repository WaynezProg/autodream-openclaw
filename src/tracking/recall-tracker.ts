import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────

export interface RecallHit {
  id: string;
  score: number;
  scope?: string;
}

export interface RecallLogEntry {
  ts: number;
  query: string;
  agentId?: string;
  hits: RecallHit[];
}

export interface RecallStats {
  memoryId: string;
  totalRecalls: number;
  uniqueQueries: number;
  avgScore: number;
  lastRecalledAt: number;
  daySpan: number;
}

export interface RecallStatsOptions {
  since?: number;
  minRecalls?: number;
  filterScopes?: string[];
}

// ── RecallTracker ──────────────────────────────────────

const LOG_FILENAME = "recall-log.jsonl";
const DEFAULT_MAX_AGE_DAYS = 90;

export class RecallTracker {
  private readonly logPath: string;

  constructor(logDir: string) {
    this.logPath = path.join(logDir, LOG_FILENAME);
  }

  /** Append a recall event to the JSONL log. */
  async record(entry: RecallLogEntry): Promise<void> {
    const dir = path.dirname(this.logPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.promises.appendFile(this.logPath, line, "utf-8");
  }

  /**
   * Build from a tool_result event.
   * Extracts query & hits from the memory_recall result payload.
   */
  recordFromToolResult(
    toolResult: { result?: unknown },
    query: string,
    agentId?: string,
  ): RecallLogEntry | null {
    const payload = toolResult.result as
      | { memories?: Array<{ id: string; score?: number; scope?: string }> }
      | undefined;
    if (!payload?.memories?.length) return null;

    const hits: RecallHit[] = payload.memories.map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      scope: m.scope,
    }));

    return { ts: Date.now(), query, agentId, hits };
  }

  /**
   * Build from an agent_end message that contains memory_recall results.
   */
  recordFromMessage(
    msg: { content?: unknown; toolName?: string },
    agentId?: string,
  ): RecallLogEntry | null {
    if (msg.toolName !== "memory_recall") return null;

    let parsed: { query?: string; memories?: Array<{ id: string; score?: number; scope?: string }> };
    try {
      parsed =
        typeof msg.content === "string" ? JSON.parse(msg.content) : (msg.content as typeof parsed);
    } catch {
      return null;
    }

    if (!parsed?.memories?.length) return null;

    const hits: RecallHit[] = parsed.memories.map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      scope: m.scope,
    }));

    return {
      ts: Date.now(),
      query: parsed.query ?? "",
      agentId,
      hits,
    };
  }

  /** Read all log entries, optionally filtered by time. */
  async readLog(since?: number): Promise<RecallLogEntry[]> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.logPath, "utf-8");
    } catch {
      return [];
    }

    const entries: RecallLogEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as RecallLogEntry;
        if (since !== undefined && entry.ts < since) continue;
        entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  /** Compute per-memory recall statistics. */
  async getStats(options?: RecallStatsOptions): Promise<RecallStats[]> {
    const entries = await this.readLog(options?.since);
    const minRecalls = options?.minRecalls ?? 0;

    // Accumulate per-memory stats
    const map = new Map<
      string,
      {
        totalRecalls: number;
        queries: Set<string>;
        scores: number[];
        lastRecalledAt: number;
        days: Set<string>;
      }
    >();

    const filterScopes = options?.filterScopes;

    for (const entry of entries) {
      for (const hit of entry.hits) {
        if (filterScopes && hit.scope && !filterScopes.includes(hit.scope)) {
          continue;
        }
        let acc = map.get(hit.id);
        if (!acc) {
          acc = {
            totalRecalls: 0,
            queries: new Set(),
            scores: [],
            lastRecalledAt: 0,
            days: new Set(),
          };
          map.set(hit.id, acc);
        }
        acc.totalRecalls++;
        if (entry.query) acc.queries.add(entry.query);
        acc.scores.push(hit.score);
        if (entry.ts > acc.lastRecalledAt) acc.lastRecalledAt = entry.ts;
        // Day key in UTC
        acc.days.add(new Date(entry.ts).toISOString().slice(0, 10));
      }
    }

    const results: RecallStats[] = [];
    for (const [memoryId, acc] of map) {
      if (acc.totalRecalls < minRecalls) continue;
      results.push({
        memoryId,
        totalRecalls: acc.totalRecalls,
        uniqueQueries: acc.queries.size,
        avgScore: acc.scores.reduce((a, b) => a + b, 0) / acc.scores.length,
        lastRecalledAt: acc.lastRecalledAt,
        daySpan: acc.days.size,
      });
    }

    // Sort by totalRecalls descending
    results.sort((a, b) => b.totalRecalls - a.totalRecalls);
    return results;
  }

  /** Delete entries older than maxAgeDays. Returns number of entries pruned. */
  async prune(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const allEntries = await this.readLog();
    const kept = allEntries.filter((e) => e.ts >= cutoff);
    const pruned = allEntries.length - kept.length;

    if (pruned === 0) return 0;

    const dir = path.dirname(this.logPath);
    await fs.promises.mkdir(dir, { recursive: true });

    if (kept.length === 0) {
      await fs.promises.writeFile(this.logPath, "", "utf-8");
    } else {
      const content = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.promises.writeFile(this.logPath, content, "utf-8");
    }

    return pruned;
  }
}
