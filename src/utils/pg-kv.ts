// kv_postgres.ts

import postgres from "postgres";

// Define Deno KV types locally to avoid external dependencies
export type KvKeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = readonly KvKeyPart[];

export interface KvEntry<T> {
  key: KvKey;
  value: T;
  versionstamp: string;
}

export interface KvEntryMaybe<T> {
  key: KvKey;
  value: T | null;
  versionstamp: string | null;
}

export type KvConsistencyLevel = "strong" | "eventual";

export interface KvListSelector {
  prefix?: KvKey;
  start?: KvKey;
  end?: KvKey;
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
  check(...checks: { key: KvKey; versionstamp: string | null }[]): this;
  mutate(...mutations: unknown[]): this;
  sum(key: KvKey, n: bigint): this;
  set(key: KvKey, value: unknown, options?: { expireIn?: number }): this;
  delete(key: KvKey): this;
  commit(): Promise<KvCommitResult | null>;
}

export interface Kv {
  get<T = unknown>(key: KvKey): Promise<KvEntry<T> | null>;
  getMany<T extends readonly unknown[]>(
    keys: readonly KvKey[],
  ): Promise<(KvEntry<T[number]> | null)[]>;
  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<KvCommitResult>;
  delete(key: KvKey): Promise<void>;
  list<T = unknown>(
    selector: KvListSelector,
    options?: KvListOptions,
  ): KvListIterator<T>;
  atomic(): KvAtomicOperation;
  watch?(
    keys: readonly KvKey[],
    options?: { raw?: boolean },
  ): ReadableStream<KvEntry<unknown>[]>;
  close(): void;
}

interface DatabaseRow {
  key_path: KvKey;
  value: unknown;
  versionstamp: number;
}

interface PostgresRow {
  key_path: string;
  value: string;
  versionstamp: number;
}

/**
 * Main class for the PostgreSQL-backed Deno KV implementation.
 */
class PostgresKv implements Kv {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  /**
   * Serializes a KvKey to a JSON string for storing in PostgreSQL.
   */
  private _serializeKey(key: KvKey): string {
    return JSON.stringify(key);
  }

  /**
   * Helper to map a database row to a KvEntry.
   */
  private _rowToEntry<T>(row: PostgresRow): KvEntry<T> {
    return {
      key: JSON.parse(row.key_path),
      value: JSON.parse(row.value) as T,
      versionstamp: row.versionstamp.toString(), // Versionstamps are strings
    };
  }

  async get<T = unknown>(key: KvKey): Promise<KvEntry<T> | null> {
    const rows = await this.sql<PostgresRow[]>`
      SELECT key_path, value, versionstamp
      FROM deno_kv
      WHERE key_path = ${this._serializeKey(key)}
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

    if (rows.length === 0) {
      return null;
    }
    return this._rowToEntry<T>(rows[0]);
  }

  async getMany<T extends readonly unknown[]>(
    keys: readonly KvKey[],
  ): Promise<Array<KvEntry<T[number]> | null>> {
    if (keys.length === 0) {
      return [];
    }

    const serializedKeys = keys.map(this._serializeKey);
    const rows = await this.sql<PostgresRow[]>`
      SELECT key_path, value, versionstamp
      FROM deno_kv
      WHERE key_path IN ${this.sql(serializedKeys)}
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

    // Create a map for quick lookups to maintain order
    const entryMap = new Map<string, KvEntry<T[number]>>();
    for (const row of rows) {
      entryMap.set(row.key_path, this._rowToEntry(row));
    }

    return keys.map((key) => entryMap.get(this._serializeKey(key)) || null);
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<KvCommitResult> {
    const serializedKey = this._serializeKey(key);
    const serializedValue = JSON.stringify(value);
    const expiresAt = options?.expireIn
      ? new Date(Date.now() + options.expireIn)
      : null;

    const result = await this.sql<{ versionstamp: number }[]>`
      INSERT INTO deno_kv (key_path, value, expires_at)
      VALUES (${serializedKey}, ${serializedValue}, ${expiresAt})
      ON CONFLICT (key_path) DO UPDATE
      SET
        value = EXCLUDED.value,
        expires_at = EXCLUDED.expires_at
      RETURNING versionstamp
    `;

    return {
      ok: true,
      versionstamp: result[0].versionstamp.toString(),
    };
  }

  async delete(key: KvKey): Promise<void> {
    await this.sql`
      DELETE FROM deno_kv
      WHERE key_path = ${this._serializeKey(key)}
    `;
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
        let query = this.sql`SELECT key_path, value, versionstamp FROM deno_kv`;
        const whereClauses = [
          this.sql`(expires_at IS NULL OR expires_at > NOW())`,
        ];

        // --- Selector Logic ---
        if ("prefix" in selector) {
          // Compare the text representation of the JSONB array
          const prefixStr = JSON.stringify(selector.prefix).slice(0, -1); // "['users']" -> "['users'"
          whereClauses.push(this.sql`key_path::text LIKE ${prefixStr + ",%"}`);
        } else {
          // Range selector
          if (selector.start) {
            whereClauses.push(
              this.sql`key_path::text >= ${this._serializeKey(selector.start)}`,
            );
          }
          if (selector.end) {
            whereClauses.push(
              this.sql`key_path::text < ${this._serializeKey(selector.end)}`,
            );
          }
        }

        // --- Cursor Logic ---
        // We use keyset pagination on the key_path itself
        if (cursor) {
          const cursorKey = JSON.parse(cursor);
          if (reverse) {
            whereClauses.push(
              this.sql`key_path::text < ${this._serializeKey(cursorKey)}`,
            );
          } else {
            whereClauses.push(
              this.sql`key_path::text > ${this._serializeKey(cursorKey)}`,
            );
          }
        }

        // Build WHERE clause by joining conditions
        let whereClause = whereClauses[0];
        for (let i = 1; i < whereClauses.length; i++) {
          whereClause = this.sql`${whereClause} AND ${whereClauses[i]}`;
        }
        query = this.sql`${query} WHERE ${whereClause}`;

        // --- Order and Limit ---
        query = this.sql`${query} ORDER BY key_path::text ${
          reverse ? this.sql`DESC` : this.sql`ASC`
        }`;
        query = this.sql`${query} LIMIT ${limit}`;

        const rows = (await query) as unknown as PostgresRow[];
        if (rows.length === 0) {
          return;
        }

        for (const row of rows) {
          yield this._rowToEntry(row as PostgresRow);
        }

        // Update cursor for the next iteration
        const lastEntry = rows[rows.length - 1];
        cursor = lastEntry.key_path;

        if (rows.length < limit) {
          return;
        }
      }
    }.bind(this)();

    // The Deno.KvListIterator requires a 'cursor' property.
    // We have to wrap the generator to expose it.
    return Object.assign(iterator, {
      get cursor() {
        return cursor ?? "";
      },
    });
  }

  atomic(): KvAtomicOperation {
    return new PostgresAtomicOperation(this.sql);
  }

  // Unsupported operations
  watch(): never {
    throw new Error(
      "The `watch` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }
  enqueue(): never {
    throw new Error(
      "The `enqueue` operation is not supported by this PostgreSQL KV wrapper.",
    );
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Handles atomic transactions.
 */
class PostgresAtomicOperation implements KvAtomicOperation {
  private sql: postgres.Sql;
  private operations: Array<(tx: postgres.Sql) => Promise<unknown>> = [];
  private checks: Array<{ key: KvKey; versionstamp: string | null }> = [];

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  private _serializeKey(key: KvKey): string {
    return JSON.stringify(key);
  }

  check(...checks: Array<{ key: KvKey; versionstamp: string | null }>): this {
    this.checks.push(...checks);
    return this;
  }

  mutate(
    ...mutations: Array<{
      type: string;
      key: KvKey;
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

  sum(key: KvKey, n: bigint): this {
    const serializedKey = this._serializeKey(key);
    this.operations.push(async (tx) => {
      // Note: This operation is complex and requires careful handling of types.
      // We use JSONB operators to perform the addition.
      await tx`
        INSERT INTO deno_kv (key_path, value)
        VALUES (${serializedKey}, jsonb_build_object('value', ${n.toString()}, 'type', 'bigint'))
        ON CONFLICT (key_path) DO UPDATE
        SET value = jsonb_set(
          deno_kv.value,
          '{value}',
          ( (deno_kv.value->>'value')::bigint + ${n.toString()} )::text::jsonb
        )
        WHERE deno_kv.value->>'type' = 'bigint'
      `;
    });
    return this;
  }

  set(key: KvKey, value: unknown, options?: { expireIn?: number }): this {
    const serializedKey = this._serializeKey(key);
    const serializedValue = JSON.stringify(value);
    const expiresAt = options?.expireIn
      ? new Date(Date.now() + options.expireIn)
      : null;

    this.operations.push(async (tx) => {
      await tx`
          INSERT INTO deno_kv (key_path, value, expires_at)
          VALUES (${serializedKey}, ${serializedValue}, ${expiresAt})
          ON CONFLICT (key_path) DO UPDATE
          SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
        `;
    });
    return this;
  }

  delete(key: KvKey): this {
    const serializedKey = this._serializeKey(key);
    this.operations.push(async (tx) => {
      await tx`DELETE FROM deno_kv WHERE key_path = ${serializedKey}`;
    });
    return this;
  }

  async commit(): Promise<KvCommitResult | null> {
    try {
      const result = await this.sql.begin(async (tx) => {
        // 1. Perform checks
        for (const check of this.checks) {
          const rows = await tx<{ versionstamp: number }[]>`
            SELECT versionstamp FROM deno_kv
            WHERE key_path = ${this._serializeKey(check.key)}
              AND (expires_at IS NULL OR expires_at > NOW())
          `;
          const currentVersion =
            rows.length > 0 ? rows[0].versionstamp.toString() : null;
          if (currentVersion !== check.versionstamp) {
            throw new Error("Atomic check failed");
          }
        }

        // 2. Execute operations
        for (const op of this.operations) {
          await op(tx);
        }

        // 3. Get the transaction ID as the commit versionstamp
        const commitVersionRows = await tx<
          { versionstamp: number }[]
        >`SELECT txid_current() as versionstamp`;
        return commitVersionRows[0];
      });

      return {
        ok: true,
        versionstamp: result.versionstamp.toString(),
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Atomic check failed") {
        return { ok: false };
      }
      // Re-throw other database errors
      throw error;
    }
  }
}

/**
 * The main entry point to open a PostgreSQL-backed KV store.
 * @param postgresUri The connection string for your PostgreSQL database.
 * @returns A promise that resolves to a Kv instance.
 */
export async function openKvPostgres(postgresUri: string): Promise<Kv> {
  const sql = postgres(postgresUri, {
    // Recommended settings for serverless environments
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  // Ensure the schema is created on first connect
  await setupSchema(sql);

  return new PostgresKv(sql);
}

/**
 * Initializes the required database schema.
 */
async function setupSchema(sql: postgres.Sql) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS deno_kv (
        versionstamp BIGSERIAL PRIMARY KEY,
        key_path JSONB NOT NULL,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS deno_kv_key_path_idx ON deno_kv (key_path);
    CREATE INDEX IF NOT EXISTS deno_kv_expires_at_idx ON deno_kv (expires_at) WHERE expires_at IS NOT NULL;

    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at') THEN
            CREATE OR REPLACE FUNCTION set_updated_at()
            RETURNS TRIGGER AS $func$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $func$ LANGUAGE plpgsql;

            CREATE TRIGGER trg_set_updated_at
            BEFORE UPDATE ON deno_kv
            FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
        END IF;
    END
    $$;
  `);
}
