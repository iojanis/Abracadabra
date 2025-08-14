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

      // Check if key_path is already a parsed object/array (JSONB column)
      if (typeof row.key_path === "object" && row.key_path !== null) {
        parsedKey = row.key_path;
      } else if (typeof row.key_path === "string") {
        try {
          // Try to parse as JSON first (legacy format)
          parsedKey = JSON.parse(row.key_path);
        } catch (_keyError) {
          // Fallback for legacy comma-separated format
          if (row.key_path.includes(",")) {
            parsedKey = row.key_path.split(",");
          } else {
            parsedKey = [row.key_path];
          }
        }
      } else {
        parsedKey = [row.key_path];
      }

      let parsedValue;

      // Check if value is already a parsed object (JSONB column)
      if (typeof row.value === "string") {
        try {
          // Legacy string format - try to parse as JSON
          parsedValue = JSON.parse(row.value);
        } catch (_valueError) {
          // Fallback: use raw value for legacy non-JSON values
          parsedValue = row.value;
        }
      } else {
        // Value is already parsed from JSONB column
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

      // Try new JSONB format first, then fallback to legacy comma format
      let result = await this.pool.query(
        `SELECT key_path, value, versionstamp::text as versionstamp
         FROM deno_kv
         WHERE key_path = $1::jsonb
         AND (expires_at IS NULL OR expires_at > NOW())`,
        [serializedKey],
      );

      // If not found with JSONB format, try legacy comma-separated format
      if (result.rows.length === 0) {
        const legacyKey = key.join(",");
        result = await this.pool.query(
          `SELECT key_path, value, versionstamp::text as versionstamp
           FROM deno_kv
           WHERE key_path = $1::jsonb
           AND (expires_at IS NULL OR expires_at > NOW())`,
          [JSON.stringify([legacyKey])],
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

      const placeholders = allKeys.map((_, i) => `$${i + 1}::jsonb`).join(", ");

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
        const keyString =
          typeof row.key_path === "object"
            ? JSON.stringify(row.key_path)
            : row.key_path;
        entryMap.set(keyString, this._rowToEntry(row as DatabaseRow));
      }

      return keys.map((key) => {
        const keyString = JSON.stringify(this._serializeKey(key));
        const legacyKeyString = key.join(",");
        return entryMap.get(keyString) || entryMap.get(legacyKeyString) || null;
      });
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
         VALUES ($1::jsonb, $2::jsonb, $3)
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
        const params: unknown[] = [];
        let paramIndex = 1;

        // Selector Logic
        if ("prefix" in selector) {
          // Use JSONB containment operator for prefix matching
          whereClauses.push(`key_path @> $${paramIndex}::jsonb`);
          params.push(JSON.stringify(selector.prefix));
          paramIndex++;
        } else {
          // Range selector
          if (selector.start) {
            whereClauses.push(`key_path >= $${paramIndex}::jsonb`);
            params.push(this._serializeKey(selector.start));
            paramIndex++;
          }
          if (selector.end) {
            whereClauses.push(`key_path < $${paramIndex}::jsonb`);
            params.push(this._serializeKey(selector.end));
            paramIndex++;
          }
        }

        // Cursor Logic
        if (cursor) {
          let cursorKey;
          try {
            cursorKey =
              typeof cursor === "string" ? JSON.parse(cursor) : cursor;
          } catch {
            cursorKey = cursor;
          }
          if (reverse) {
            whereClauses.push(`key_path < $${paramIndex}::jsonb`);
          } else {
            whereClauses.push(`key_path > $${paramIndex}::jsonb`);
          }
          params.push(
            Array.isArray(cursorKey)
              ? JSON.stringify(cursorKey)
              : this._serializeKey(cursorKey),
          );
          paramIndex++;
        }

        query += ` WHERE ${whereClauses.join(" AND ")}`;
        query += ` ORDER BY key_path ${reverse ? "DESC" : "ASC"}`;
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
        cursor =
          typeof lastEntry.key_path === "object"
            ? JSON.stringify(lastEntry.key_path)
            : lastEntry.key_path;

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

  enqueue(): Promise<KvCommitResult> {
    throw new Error(
      "The `enqueue` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }

  listenQueue(): Promise<void> {
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
         VALUES ($1::jsonb, $2::jsonb, $3)
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
      await client.query(`DELETE FROM deno_kv WHERE key_path = $1::jsonb`, [
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
           WHERE key_path = $1::jsonb AND (expires_at IS NULL OR expires_at > NOW())`,
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
 * Migrates legacy data from comma-separated keys and JSON strings to proper JSONB format.
 */
async function migrateLegacyData(pool: Pool): Promise<void> {
  try {
    console.log("[PG-KV] Checking for legacy data to migrate...");

    // Check if migration has already been completed
    try {
      const migrationCheck = await pool.query(`
        SELECT value FROM deno_kv
        WHERE key_path = '["_migration","completed"]'::jsonb
      `);

      if (migrationCheck.rows.length > 0) {
        console.log("[PG-KV] Migration already completed, skipping");
        return;
      }
    } catch {
      // If table doesn't exist or has issues, continue with migration
    }

    // Check if there's any data in the table
    const totalDataCheck = await pool.query(
      `SELECT COUNT(*) as count FROM deno_kv`,
    );
    const totalCount = parseInt(totalDataCheck.rows[0].count);

    if (totalCount === 0) {
      console.log(
        "[PG-KV] No data found in table, marking migration as complete",
      );
      await pool.query(`
        INSERT INTO deno_kv (key_path, value, created_at, updated_at)
        VALUES ('["_migration","completed"]'::jsonb, 'true'::jsonb, NOW(), NOW())
        ON CONFLICT (key_path) DO NOTHING
      `);
      return;
    }

    console.log(
      `[PG-KV] Found ${totalCount} total records, checking for problematic data...`,
    );

    // Check for any non-JSONB data by trying to access jsonb functions
    let problematicCount = 0;
    try {
      const problematicDataCheck = await pool.query(`
        SELECT COUNT(*) as count FROM deno_kv
        WHERE key_path != '["_migration","completed"]'::jsonb
        AND NOT (
          (key_path::text ~ '^\\[.*\\]$' OR key_path::text ~ '^\\{.*\\}$') AND
          (value::text ~ '^\\[.*\\]$' OR value::text ~ '^\\{.*\\}$' OR value::text ~ '^".*"$' OR value::text ~ '^[0-9]+(\\.[0-9]+)?$' OR value::text IN ('true', 'false', 'null'))
        )
      `);
      problematicCount = parseInt(problematicDataCheck.rows[0].count);
    } catch {
      // If the check fails, assume all data needs migration
      problematicCount = totalCount;
    }

    if (problematicCount === 0) {
      console.log(
        "[PG-KV] No problematic data found, marking migration as complete",
      );
      await pool.query(`
        INSERT INTO deno_kv (key_path, value, created_at, updated_at)
        VALUES ('["_migration","completed"]'::jsonb, 'true'::jsonb, NOW(), NOW())
        ON CONFLICT (key_path) DO NOTHING
      `);
      return;
    }

    console.log(
      `[PG-KV] Found ${problematicCount} records that need migration...`,
    );

    // Create single backup table (only if it doesn't exist)
    console.log("[PG-KV] Creating backup table...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deno_kv_backup AS
      SELECT * FROM deno_kv WHERE false
    `);

    // Insert backup data (only if backup is empty)
    const backupCheck = await pool.query(
      `SELECT COUNT(*) as count FROM deno_kv_backup`,
    );
    if (parseInt(backupCheck.rows[0].count) === 0) {
      await pool.query(`INSERT INTO deno_kv_backup SELECT * FROM deno_kv`);
      console.log("[PG-KV] Data backed up to deno_kv_backup table");
    }

    // Create a temporary table with text columns
    await pool.query(`
      CREATE TEMP TABLE deno_kv_temp (
        versionstamp BIGINT,
        key_path_raw TEXT,
        value_raw TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      )
    `);

    // Copy all data to temp table as text
    await pool.query(`
      INSERT INTO deno_kv_temp
      SELECT versionstamp, key_path::text, value::text, expires_at, created_at, updated_at
      FROM deno_kv
    `);

    // Clear the original table
    await pool.query(`DELETE FROM deno_kv`);

    // Migrate data from temp table with proper conversion
    await pool.query(`
      INSERT INTO deno_kv (key_path, value, expires_at, created_at, updated_at)
      SELECT
        CASE
          -- Handle array-like strings: ["a","b","c"]
          WHEN key_path_raw ~ '^\\[.*\\]$' THEN key_path_raw::jsonb
          -- Handle comma-separated: a,b,c
          WHEN key_path_raw ~ ',' THEN ('["' || replace(key_path_raw, ',', '","') || '"]')::jsonb
          -- Handle single values
          ELSE ('["' || key_path_raw || '"]')::jsonb
        END as key_path,
        CASE
          -- Already valid JSON
          WHEN value_raw ~ '^[\\[\\{].*[\\]\\}]$' THEN value_raw::jsonb
          -- Quoted strings
          WHEN value_raw ~ '^".*"$' THEN value_raw::jsonb
          -- Numbers
          WHEN value_raw ~ '^[0-9]+(\\.[0-9]+)?$' THEN value_raw::jsonb
          -- Booleans
          WHEN value_raw IN ('true', 'false') THEN value_raw::jsonb
          -- Null
          WHEN value_raw = 'null' THEN 'null'::jsonb
          -- Everything else as quoted string
          ELSE ('"' || replace(value_raw, '"', '\\"') || '"')::jsonb
        END as value,
        expires_at,
        COALESCE(created_at, NOW()),
        COALESCE(updated_at, NOW())
      FROM deno_kv_temp
    `);

    // Mark migration as completed
    await pool.query(`
      INSERT INTO deno_kv (key_path, value, created_at, updated_at)
      VALUES ('["_migration","completed"]'::jsonb, 'true'::jsonb, NOW(), NOW())
      ON CONFLICT (key_path) DO NOTHING
    `);

    const migratedCount = await pool.query(
      `SELECT COUNT(*) as count FROM deno_kv WHERE key_path != '["_migration","completed"]'::jsonb`,
    );
    console.log(
      `[PG-KV] Successfully migrated ${migratedCount.rows[0].count} records`,
    );

    // Drop temp table
    await pool.query(`DROP TABLE deno_kv_temp`);

    console.log("[PG-KV] Legacy data migration completed successfully");
  } catch (error) {
    console.warn(
      "[PG-KV] Legacy data migration failed, continuing with existing data:",
      (error as Error).message,
    );
    // Don't throw - we want the server to continue even if migration fails
  }
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

    // Migrate legacy data if it exists
    await migrateLegacyData(pool);

    console.log("[PG-KV] Database schema setup completed successfully");
  } catch (error) {
    console.error("[PG-KV] Schema setup error:", (error as Error).message);
    throw error;
  }
}
