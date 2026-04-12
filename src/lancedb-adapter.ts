import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";

// LanceDB 路徑（實際探查結果：lancedb-pro）
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "memory",
  "lancedb-pro",
);

const DEFAULT_TABLE_NAME = "memories";

export interface MemoryRecord {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string; // JSON string
  vector: number[];
}

export interface ParsedMetadata {
  l0_abstract?: string;
  l1_overview?: string;
  l2_content?: string;
  memory_category?: string;
  tier?: "core" | "working" | "peripheral";
  access_count?: number;
  confidence?: number;
  last_accessed_at?: number;
  valid_from?: number;
  invalidated_at?: number;
  fact_key?: string;
  supersedes?: string;
  superseded_by?: string;
  source_session?: string;
}

export function parseMetadata(raw: string): ParsedMetadata {
  try {
    return JSON.parse(raw) as ParsedMetadata;
  } catch {
    return {};
  }
}

export interface LanceDbAdapterOptions {
  dbPath?: string;
  tableName?: string;
  /** Max memories to scan (default: 10000) */
  scanLimit?: number;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      void timer;
    }),
  ]);
}

export class LanceDbAdapter {
  private readonly dbPath: string;
  private readonly tableName: string;
  private readonly scanLimit: number;
  private db: lancedb.Connection | null = null;

  constructor(opts?: LanceDbAdapterOptions) {
    this.dbPath = opts?.dbPath ?? DEFAULT_DB_PATH;
    this.tableName = opts?.tableName ?? DEFAULT_TABLE_NAME;
    this.scanLimit = opts?.scanLimit ?? 10000;
  }

  async connect(): Promise<void> {
    this.db = await withTimeout(
      lancedb.connect(this.dbPath),
      `LanceDB connect (${this.dbPath})`,
    );
  }

  async close(): Promise<void> {
    this.db = null;
  }

  private ensureConnected(): lancedb.Connection {
    if (!this.db) {
      throw new Error("LanceDB not connected. Call connect() first.");
    }
    return this.db;
  }

  async listTableNames(): Promise<string[]> {
    const db = this.ensureConnected();
    return await db.tableNames();
  }

  async getTableSchema(): Promise<string[]> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const schema = await table.schema();
      return schema.fields.map((f) => f.name);
    } catch (err) {
      throw new Error(
        `Failed to read schema for table "${this.tableName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async listAllMemories(scope?: string): Promise<MemoryRecord[]> {
    const db = this.ensureConnected();

    let table: lancedb.Table;
    try {
      table = await withTimeout(
        db.openTable(this.tableName),
        `LanceDB openTable(${this.tableName})`,
      );
    } catch {
      return [];
    }

    // 取得所有 columns 名稱來偵測 schema
    const schema = await table.schema();
    const columnNames = new Set(schema.fields.map((f) => f.name));

    // 確認必要欄位存在
    const required = ["id", "text"] as const;
    for (const col of required) {
      if (!columnNames.has(col)) {
        throw new Error(
          `Unexpected schema: missing required column "${col}". ` +
            `Found columns: ${[...columnNames].join(", ")}`,
        );
      }
    }

    // 偵測 vector column 名稱
    const vectorCol = columnNames.has("vector")
      ? "vector"
      : columnNames.has("embedding")
        ? "embedding"
        : null;

    // 查詢所有記憶（LanceDB 預設 limit=10，必須明確設定）
    let query = table.query().limit(this.scanLimit);
    if (scope) {
      const escaped = scope.replace(/'/g, "''");
      query = query.where(`scope = '${escaped}'`);
    }

    const rows = (await query.toArray()) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: String(row["id"] ?? ""),
      text: String(row["text"] ?? ""),
      category: String(row["category"] ?? "other"),
      scope: String(row["scope"] ?? ""),
      importance: Number(row["importance"] ?? 0),
      timestamp: Number(row["timestamp"] ?? 0),
      metadata: String(row["metadata"] ?? "{}"),
      vector: vectorCol ? toNumberArray(row[vectorCol]) : [],
    }));
  }

  /**
   * Update the text field of a memory record.
   * Note: Does NOT re-embed — vector will be slightly stale but semantically similar.
   * Returns true if the update was applied.
   */
  async updateMemoryText(id: string, newText: string): Promise<boolean> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const escapedId = id.replace(/'/g, "''");
      await table.update({
        where: `id = '${escapedId}'`,
        values: { text: newText },
      });
      return true;
    } catch (err) {
      console.error(`[lancedb-adapter] updateMemoryText error for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Update text and vector of a memory record.
   * Used after merge to re-embed with the new text.
   */
  async updateMemoryTextAndVector(
    id: string,
    newText: string,
    newVector: number[],
  ): Promise<boolean> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const schema = await table.schema();
      const columnNames = new Set(schema.fields.map((f) => f.name));
      const vectorCol = columnNames.has("vector")
        ? "vector"
        : columnNames.has("embedding")
          ? "embedding"
          : null;

      const escapedId = id.replace(/'/g, "''");
      if (vectorCol) {
        await table.update({
          where: `id = '${escapedId}'`,
          values: { text: newText, [vectorCol]: newVector } as Record<string, string>,
        });
      } else {
        await table.update({
          where: `id = '${escapedId}'`,
          values: { text: newText } as Record<string, string>,
        });
      }
      return true;
    } catch (err) {
      console.error(
        `[lancedb-adapter] updateMemoryTextAndVector error for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Delete a memory by ID. Returns true if successful. */
  async deleteMemory(id: string): Promise<boolean> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const escapedId = id.replace(/'/g, "''");
      await table.delete(`id = '${escapedId}'`);
      return true;
    } catch (err) {
      console.error(
        `[lancedb-adapter] deleteMemory error for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Store a new memory record in LanceDB.
   * Returns true if successful.
   */
  async store(record: {
    id: string;
    text: string;
    category: string;
    scope: string;
    importance: number;
    timestamp: number;
    metadata: string;
    vector: number[];
  }): Promise<boolean> {
    const db = this.ensureConnected();
    try {
      const table = await withTimeout(
        db.openTable(this.tableName),
        `LanceDB openTable(${this.tableName})`,
      );
      await withTimeout(
        table.add([record]),
        `LanceDB add(${this.tableName})`,
      );
      return true;
    } catch (err) {
      console.error(
        `[lancedb-adapter] store error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search. Returns matching records above the given threshold.
   * @param vector - query vector
   * @param limit - max results to return
   * @param minScore - minimum similarity score (0-1). Records below this are filtered out.
   */
  async search(
    vector: number[],
    limit: number,
    minScore?: number,
  ): Promise<Array<MemoryRecord & { _distance: number }>> {
    const db = this.ensureConnected();
    try {
      const table = await withTimeout(
        db.openTable(this.tableName),
        `LanceDB openTable(${this.tableName})`,
      );
      const results = await withTimeout(
        table
          .search(vector)
          .limit(limit)
          .toArray(),
        `LanceDB search(${this.tableName})`,
      );

      const mapped = (results as Record<string, unknown>[]).map((row) => ({
        id: String(row["id"] ?? ""),
        text: String(row["text"] ?? ""),
        category: String(row["category"] ?? "other"),
        scope: String(row["scope"] ?? ""),
        importance: Number(row["importance"] ?? 0),
        timestamp: Number(row["timestamp"] ?? 0),
        metadata: String(row["metadata"] ?? "{}"),
        vector: toNumberArray(row["vector"] ?? row["embedding"]),
        _distance: Number(row["_distance"] ?? 1),
      }));

      if (minScore !== undefined) {
        // LanceDB returns L2 distance; convert to cosine similarity approximation
        // For normalized vectors: similarity ≈ 1 - distance/2
        return mapped.filter((r) => {
          const similarity = 1 - r._distance / 2;
          return similarity >= minScore;
        });
      }

      return mapped;
    } catch (err) {
      console.error(
        `[lancedb-adapter] search error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  async countMemories(scope?: string): Promise<number> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const filter = scope ? `scope = '${scope.replace(/'/g, "''")}'` : undefined;
      return await table.countRows(filter);
    } catch {
      return 0;
    }
  }
}

function toNumberArray(val: unknown): number[] {
  if (Array.isArray(val)) {
    return val.map(Number);
  }
  if (val instanceof Float32Array || val instanceof Float64Array) {
    return Array.from(val);
  }
  return [];
}
