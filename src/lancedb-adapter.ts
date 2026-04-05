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
    this.db = await lancedb.connect(this.dbPath);
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
      table = await db.openTable(this.tableName);
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
      query = query.where(`scope = '${scope}'`);
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

  async countMemories(scope?: string): Promise<number> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const filter = scope ? `scope = '${scope}'` : undefined;
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
