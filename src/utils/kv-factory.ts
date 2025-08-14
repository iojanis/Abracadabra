// KV Factory - Switch between Deno KV and PostgreSQL KV implementations
// Supports both local development with Deno KV and production with PostgreSQL

import type { Kv } from "./pg-kv.ts";
import { openKvPostgres } from "./pg-kv.ts";

export interface KvConfig {
  provider: "deno" | "postgres";
  denoKvPath?: string;
  postgresUrl?: string | undefined;
}

/**
 * Reads KV configuration from environment variables
 */
function getKvConfigFromEnv(): KvConfig {
  const provider = (Deno.env.get("KV_PROVIDER") || "deno").toLowerCase() as
    | "deno"
    | "postgres";
  const denoKvPath = Deno.env.get("ABRACADABRA_KV_PATH") || "./data/kv.db";
  const postgresUrl =
    Deno.env.get("DATABASE_URL") || Deno.env.get("POSTGRES_URL");

  return {
    provider,
    denoKvPath,
    postgresUrl,
  };
}

/**
 * Creates a KV instance based on the provided configuration
 * @param config KV configuration object
 * @returns Promise that resolves to a Kv instance
 */
export async function createKv(config?: Partial<KvConfig>): Promise<Kv> {
  const finalConfig = { ...getKvConfigFromEnv(), ...config };

  switch (finalConfig.provider) {
    case "postgres": {
      if (!finalConfig.postgresUrl) {
        throw new Error(
          "PostgreSQL URL is required when using postgres KV provider. " +
            "Set DATABASE_URL or POSTGRES_URL environment variable.",
        );
      }

      console.log(
        `[KV] Using PostgreSQL KV provider with URL: ${finalConfig.postgresUrl.replace(/\/\/[^@]+@/, "//*****@")}`,
      );
      return await openKvPostgres(finalConfig.postgresUrl);
    }

    case "deno":
    default: {
      console.log(
        `[KV] Using Deno KV provider with path: ${finalConfig.denoKvPath}`,
      );
      return await Deno.openKv(finalConfig.denoKvPath);
    }
  }
}

/**
 * Creates a KV instance using environment variables
 * This is the main entry point for the application
 */
export async function createKvFromEnv(): Promise<Kv> {
  return await createKv();
}

/**
 * Validates the KV configuration without creating a connection
 * Useful for startup checks
 */
export function validateKvConfig(config?: Partial<KvConfig>): {
  valid: boolean;
  errors: string[];
} {
  const finalConfig = { ...getKvConfigFromEnv(), ...config };
  const errors: string[] = [];

  if (finalConfig.provider === "postgres" && !finalConfig.postgresUrl) {
    errors.push(
      "PostgreSQL URL is required when using postgres KV provider. " +
        "Set DATABASE_URL or POSTGRES_URL environment variable.",
    );
  }

  if (finalConfig.provider === "deno" && !finalConfig.denoKvPath) {
    errors.push("Deno KV path is required when using deno KV provider.");
  }

  if (!["deno", "postgres"].includes(finalConfig.provider)) {
    errors.push(
      `Invalid KV provider: ${finalConfig.provider}. Must be 'deno' or 'postgres'.`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Gets the current KV configuration from environment
 */
export function getKvConfig(): KvConfig {
  return getKvConfigFromEnv();
}
