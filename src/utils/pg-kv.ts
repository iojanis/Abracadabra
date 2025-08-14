// PostgreSQL KV implementation for Deno Deploy zero configuration
// Uses standard pg library with automatic environment variable detection

import { Pool, type PoolClient } from "npm:pg";
import { isDenoDeploy } from "./environment.ts";

// Define Deno KV types locally to avoid external dependencies
export type KvKeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = readonly KvKeyPart[];

// For compatibility with Deno.Kv types
export type DenoKvKeyPart = KvKeyPart | symbol;
export type DenoKvKey = readonly DenoKvKeyPart[];

export interface KvEntry<T> {
  key: DenoKvKey;
  value: T;
  versionstamp: string;
}

export interface KvEntryMaybe<T> {
  key: DenoKvKey;
  value: T | null;
  versionstamp: string | null;
}

export type KvConsistencyLevel = "strong" | "eventual";

export interface KvListSelector {
  prefix?: DenoKvKey;
  start?: DenoKvKey;
  end?: DenoKvKey;
}

export interface KvListOptions {
  limit?: number;
  cursor?: string;
  reverse?: boolean;
  consistency?: KvConsistencyLevel;
}

export interface KvListIterator<T> extends AsyncIterable<KvEntry<T>> {
  readonly cursor: string;
}

export interface KvCommitResult {
  ok: boolean;
  versionstamp?: string;
}

export interface KvAtomicOperation {
  check(...checks: { key: DenoKvKey; versionstamp: string | null }[]): this;
  mutate(...mutations: unknown[]): this;
  sum(key: DenoKvKey, n: bigint): this;
  set(key: DenoKvKey, value: unknown, options?: { expireIn?: number }): this;
  delete(key: DenoKvKey): this;
  commit(): Promise<KvCommitResult | null>;
}

export interface Kv {
  get<T = unknown>(key: DenoKvKey): Promise<KvEntry<T> | null>;
  getMany<T extends readonly unknown[]>(
    keys: readonly DenoKvKey[],
  ): Promise<(KvEntry<T[number]> | null)[]>;
  set(
    key: DenoKvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<KvCommitResult>;
  delete(key: DenoKvKey): Promise<void>;
  list<T = unknown>(
    selector: KvListSelector,
    options?: KvListOptions,
  ): KvListIterator<T>;
  atomic(): KvAtomicOperation;
  watch?(
    keys: readonly DenoKvKey[],
    options?: { raw?: boolean },
  ): ReadableStream<KvEntry<unknown>[]>;
  enqueue(
    value: unknown,
    options?: {
      delay?: number;
      keysIfUndelivered?: DenoKvKey[];
      backoffSchedule?: number[];
    },
  ): Promise<KvCommitResult>;
  listenQueue(handler: (value: unknown) => Promise<void> | void): Promise<void>;
  commitVersionstamp?(): symbol;
  close(): void;
  [Symbol.dispose](): void;
}

interface DatabaseRow {
  key_path: string;
  value: string;
  versionstamp: string;
}

/**
 * Main class for the PostgreSQL-backed Deno KV implementation using zero config.
 */
class PostgresKv implements Kv {
  private pool: Pool;
  private isDeployEnv: boolean;

  constructor(pool: Pool) {
    this.pool = pool;
    this.isDeployEnv = isDenoDeploy();
  }

  /**
   * Serializes a KvKey to a JSON string for storing in PostgreSQL.
   * Filters out symbols since PostgreSQL cannot store them.
   */
  private _serializeKey(key: DenoKvKey): string {
    try {
      // Filter out symbols as PostgreSQL cannot store them
      const filteredKey = key.filter(
        (part) => typeof part !== "symbol",
      ) as KvKey;

      // Ensure we have an array
      if (!Array.isArray(key)) {
        console.warn("[PG-KV] Key is not an array:", key);
        return JSON.stringify([key]);
      }

      return JSON.stringify(filteredKey);
    } catch (error) {
      console.error("[PG-KV] Error serializing key:", {
        key,
        error: (error as Error).message,
      });
      // Fallback - treat as single key
      return JSON.stringify([String(key)]);
    }
  }

  /**
   * Helper to map a database row to a KvEntry.
   * Handles both new JSON format and legacy comma-separated format.
   */
  private _rowToEntry<T>(row: DatabaseRow): KvEntry<T> {
    try {
      let parsedKey;
      try {
        // Try to parse as JSON first (new format)
        parsedKey = JSON.parse(row.key_path);
      } catch (keyError) {
        // Fallback for legacy comma-separated format
        if (typeof row.key_path === "string" && row.key_path.includes(",")) {
          parsedKey = row.key_path.split(",");
        } else {
          parsedKey = [row.key_path];
        }
      }

      let parsedValue;
      try {
        // Try to parse as JSON first (new format)
        parsedValue = JSON.parse(row.value);
      } catch (valueError) {
        // Fallback: use raw value for legacy non-JSON values
        parsedValue = row.value;
      }

      return {
        key: parsedKey,
        value: parsedValue as T,
        versionstamp: row.versionstamp,
      };
    } catch (error) {
      console.error("[PG-KV] Error in _rowToEntry:", {
        row,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async get<T = unknown>(key: DenoKvKey): Promise<KvEntry<T> | null> {
    try {
      const serializedKey = this._serializeKey(key);

      // Try new JSON format first, then fallback to legacy comma format
      let result = await this.pool.query(
        `SELECT key_path, value, versionstamp::text as versionstamp
         FROM deno_kv
         WHERE key_path = $1
         AND (expires_at IS NULL OR expires_at > NOW())`,
        [serializedKey],
      );

      // If not found with JSON format, try legacy comma-separated format
      if (result.rows.length === 0) {
        const legacyKey = key.join(",");
        result = await this.pool.query(
          `SELECT key_path, value, versionstamp::text as versionstamp
           FROM deno_kv
           WHERE key_path = $1
           AND (expires_at IS NULL OR expires_at > NOW())`,
          [legacyKey],
        );
      }

      if (result.rows.length === 0) {
        return null;
      }

      return this._rowToEntry<T>(result.rows[0] as DatabaseRow);
    } catch (error) {
      console.error("[PG-KV] Error in get operation:", {
        key,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async getMany<T extends readonly unknown[]>(
    keys: readonly DenoKvKey[],
  ): Promise<Array<KvEntry<T[number]> | null>> {
    if (keys.length === 0) {
      return [];
    }

    try {
      const serializedKeys = keys.map((key) => this._serializeKey(key));
      const legacyKeys = keys.map((key) => key.join(","));
      const allKeys = [...serializedKeys, ...legacyKeys];
      const placeholders = allKeys.map((_, i) => `$${i + 1}`).join(", ");

      const result = await this.pool.query(
        `SELECT key_path, value, versionstamp::text as versionstamp
         FROM deno_kv
         WHERE key_path IN (${placeholders})
         AND (expires_at IS NULL OR expires_at > NOW())`,
        allKeys,
      );

      // Create a map for quick lookups to maintain order
      const entryMap = new Map<string, KvEntry<T[number]>>();
      for (const row of result.rows) {
        entryMap.set(row.key_path, this._rowToEntry(row as DatabaseRow));
      }

      return keys.map((key) => entryMap.get(this._serializeKey(key)) || null);
    } catch (error) {
      console.error(
        "[PG-KV] Error in getMany operation:",
        (error as Error).message,
      );
      throw error;
    }
  }

  async set(
    key: DenoKvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<KvCommitResult> {
    try {
      const serializedKey = this._serializeKey(key);
      const serializedValue = JSON.stringify(value);
      const expiresAt = options?.expireIn
        ? new Date(Date.now() + options.expireIn).toISOString()
        : null;

      const result = await this.pool.query(
        `INSERT INTO deno_kv (key_path, value, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key_path) DO UPDATE SET
           value = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
         RETURNING versionstamp::text as versionstamp`,
        [serializedKey, serializedValue, expiresAt],
      );

      return {
        ok: true,
        versionstamp: result.rows[0].versionstamp,
      };
    } catch (error) {
      console.error(
        "[PG-KV] Error in set operation:",
        (error as Error).message,
      );
      throw error;
    }
  }

  async delete(key: DenoKvKey): Promise<void> {
    try {
      const serializedKey = this._serializeKey(key);
      await this.pool.query(`DELETE FROM deno_kv WHERE key_path = $1`, [
        serializedKey,
      ]);
    } catch (error) {
      console.error(
        "[PG-KV] Error in delete operation:",
        (error as Error).message,
      );
      throw error;
    }
  }

  list<T = unknown>(
    selector: KvListSelector,
    options?: KvListOptions,
  ): KvListIterator<T> {
    let cursor: string | undefined = options?.cursor;

    const iterator = async function* (
      this: PostgresKv,
    ): AsyncGenerator<KvEntry<T>, void, unknown> {
      const limit = options?.limit ?? 100;
      const reverse = options?.reverse ?? false;

      while (true) {
        let query = `SELECT key_path, value, versionstamp::text as versionstamp FROM deno_kv`;
        const whereClauses: string[] = [
          `(expires_at IS NULL OR expires_at > NOW())`,
        ];
        const params: any[] = [];
        let paramIndex = 1;

        // Selector Logic
        if ("prefix" in selector) {
          const prefixStr = JSON.stringify(selector.prefix).slice(0, -1); // Remove trailing ]
          whereClauses.push(`key_path::text LIKE $${paramIndex}`);
          params.push(prefixStr + ",%");
          paramIndex++;
        } else {
          // Range selector
          if (selector.start) {
            whereClauses.push(`key_path::text >= $${paramIndex}`);
            params.push(this._serializeKey(selector.start));
            paramIndex++;
          }
          if (selector.end) {
            whereClauses.push(`key_path::text < $${paramIndex}`);
            params.push(this._serializeKey(selector.end));
            paramIndex++;
          }
        }

        // Cursor Logic
        if (cursor) {
          const cursorKey = JSON.parse(cursor);
          if (reverse) {
            whereClauses.push(`key_path::text < $${paramIndex}`);
          } else {
            whereClauses.push(`key_path::text > $${paramIndex}`);
          }
          params.push(this._serializeKey(cursorKey));
          paramIndex++;
        }

        query += ` WHERE ${whereClauses.join(" AND ")}`;
        query += ` ORDER BY key_path::text ${reverse ? "DESC" : "ASC"}`;
        query += ` LIMIT $${paramIndex}`;
        params.push(limit);

        const result = await this.pool.query(query, params);

        if (result.rows.length === 0) {
          return;
        }

        for (const row of result.rows) {
          yield this._rowToEntry(row as DatabaseRow);
        }

        // Update cursor for the next iteration
        const lastEntry = result.rows[result.rows.length - 1];
        cursor = lastEntry.key_path;

        if (result.rows.length < limit) {
          return;
        }
      }
    }.bind(this)();

    return Object.assign(iterator, {
      get cursor() {
        return cursor ?? "";
      },
    });
  }

  atomic(): KvAtomicOperation {
    return new PostgresAtomicOperation(this.pool);
  }

  // Unsupported operations
  watch(): never {
    throw new Error(
      "The `watch` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }

  async enqueue(): Promise<KvCommitResult> {
    throw new Error(
      "The `enqueue` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }

  async listenQueue(): Promise<void> {
    throw new Error(
      "The `listenQueue` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }

  commitVersionstamp?(): symbol {
    throw new Error(
      "The `commitVersionstamp` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }

  [Symbol.dispose](): void {
    // No-op for compatibility
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Handles atomic transactions using pg.
 */
class PostgresAtomicOperation implements KvAtomicOperation {
  private pool: Pool;
  private operations: Array<(client: PoolClient) => Promise<unknown>> = [];
  private checks: Array<{ key: DenoKvKey; versionstamp: string | null }> = [];

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private _serializeKey(key: DenoKvKey): string {
    const filteredKey = key.filter((part) => typeof part !== "symbol") as KvKey;
    return JSON.stringify(filteredKey);
  }

  check(
    ...checks: Array<{ key: DenoKvKey; versionstamp: string | null }>
  ): this {
    this.checks.push(...checks);
    return this;
  }

  mutate(
    ...mutations: Array<{
      type: string;
      key: DenoKvKey;
      value?: unknown;
      expireIn?: number;
    }>
  ): this {
    for (const op of mutations) {
      if (op.type === "set") {
        this.set(
          op.key,
          op.value,
          op.expireIn ? { expireIn: op.expireIn } : undefined,
        );
      } else if (op.type === "delete") {
        this.delete(op.key);
      } else if (op.type === "sum") {
        this.sum(op.key, op.value as bigint);
      }
    }
    return this;
  }

  sum(key: DenoKvKey, n: bigint): this {
    const serializedKey = this._serializeKey(key);
    this.operations.push(async (client) => {
      await client.query(
        `INSERT INTO deno_kv (key_path, value)
         VALUES ($1, $2)
         ON CONFLICT (key_path) DO UPDATE SET
           value = jsonb_set(
             deno_kv.value,
             '{value}',
             (((deno_kv.value->>'value')::bigint + $3)::text)::jsonb
           )
         WHERE deno_kv.value->>'type' = 'bigint'`,
        [
          serializedKey,
          JSON.stringify({ value: n.toString(), type: "bigint" }),
          n.toString(),
        ],
      );
    });
    return this;
  }

  set(key: DenoKvKey, value: unknown, options?: { expireIn?: number }): this {
    const serializedKey = this._serializeKey(key);
    const serializedValue = JSON.stringify(value);
    const expiresAt = options?.expireIn
      ? new Date(Date.now() + options.expireIn).toISOString()
      : null;

    this.operations.push(async (client) => {
      await client.query(
        `INSERT INTO deno_kv (key_path, value, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key_path) DO UPDATE SET
           value = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [serializedKey, serializedValue, expiresAt],
      );
    });
    return this;
  }

  delete(key: DenoKvKey): this {
    const serializedKey = this._serializeKey(key);
    this.operations.push(async (client) => {
      await client.query(`DELETE FROM deno_kv WHERE key_path = $1`, [
        serializedKey,
      ]);
    });
    return this;
  }

  async commit(): Promise<KvCommitResult | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Perform checks
      for (const check of this.checks) {
        const result = await client.query(
          `SELECT versionstamp::text as versionstamp FROM deno_kv
           WHERE key_path = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
          [this._serializeKey(check.key)],
        );

        const currentVersion =
          result.rows.length > 0 ? result.rows[0].versionstamp : null;
        if (currentVersion !== check.versionstamp) {
          await client.query("ROLLBACK");
          return { ok: false };
        }
      }

      // Execute operations
      for (const op of this.operations) {
        await op(client);
      }

      // Get transaction ID as versionstamp
      const result = await client.query(
        "SELECT txid_current()::text as versionstamp",
      );
      await client.query("COMMIT");

      return {
        ok: true,
        versionstamp: result.rows[0].versionstamp,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message === "Atomic check failed") {
        return { ok: false };
      }
      console.error(
        "[PG-KV] Atomic operation failed:",
        (error as Error).message,
      );
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Zero configuration entry point for Deno Deploy.
 * Uses standard pg library with automatic environment variable detection.
 */
export async function openKvPostgres(): Promise<Kv> {
  const isDeployEnv = isDenoDeploy();

  console.log(
    `[PG-KV] Creating PostgreSQL connection pool ${isDeployEnv ? "[Deploy - Zero Config]" : "[Local]"}`,
  );

  // Zero configuration - pg will automatically use environment variables
  // PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE
  const pool = new Pool({
    // Let pg handle all configuration via environment variables
    // No manual configuration needed for Deno Deploy
    max: 1, // Single connection for serverless
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
  });

  try {
    // Test connection and ensure schema exists
    console.log("[PG-KV] Testing database connection...");
    await setupSchema(pool);
    console.log("[PG-KV] Database connection and schema verified");
  } catch (error) {
    console.error(`[PG-KV] Database setup failed: ${(error as Error).message}`);
    throw error;
  }

  return new PostgresKv(pool);
}

/**
 * Initializes the required database schema using zero config.
 */
async function setupSchema(pool: Pool): Promise<void> {
  try {
    // Test connection first
    await pool.query("SELECT 1");

    // Create table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deno_kv (
        versionstamp BIGSERIAL PRIMARY KEY,
        key_path JSONB NOT NULL,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Create indexes
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS deno_kv_key_path_idx ON deno_kv (key_path)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS deno_kv_expires_at_idx ON deno_kv (expires_at)
      WHERE expires_at IS NOT NULL
    `);

    // Create trigger function and trigger
    await pool.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await pool.query(`
      DROP TRIGGER IF EXISTS trg_set_updated_at ON deno_kv
    `);

    await pool.query(`
      CREATE TRIGGER trg_set_updated_at
      BEFORE UPDATE ON deno_kv
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at()
    `);

    console.log("[PG-KV] Database schema setup completed successfully");
  } catch (error) {
    console.error("[PG-KV] Schema setup error:", (error as Error).message);
    throw error;
  }
}
