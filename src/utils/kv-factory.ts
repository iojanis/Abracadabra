// KV Factory - Switch between Deno KV and PostgreSQL KV implementations
// Supports both local development with Deno KV and production with PostgreSQL
// Includes Deno Deploy compatibility safeguards

import type { Kv } from "./pg-kv.ts";
import { openKvPostgres } from "./pg-kv.ts";

/**
 * Detect if running on Deno Deploy
 */
function isDenoDeploy(): boolean {
  return !!(
    Deno.env.get("DENO_DEPLOYMENT_ID") ||
    Deno.env.get("DENO_REGION") ||
    globalThis.location?.hostname?.includes("deno.dev")
  );
}

/**
 * Detect if running in production environment
 */
function isProduction(): boolean {
  const env = Deno.env.get("DENO_ENV") || Deno.env.get("NODE_ENV");
  return env === "production" || isDenoDeploy();
}

export interface KvConfig {
  provider: "deno" | "postgres";
  denoKvPath?: string;
}

/**
 * Reads KV configuration from environment variables with Deno Deploy safeguards
 */
function getKvConfigFromEnv(): KvConfig {
  const isDeployEnv = isDenoDeploy();
  const isProdEnv = isProduction();

  // Auto-detect provider based on environment with Deploy override
  let provider = (Deno.env.get("KV_PROVIDER") || "deno").toLowerCase() as
    | "deno"
    | "postgres";

  // On Deno Deploy with database attached, prefer PostgreSQL for zero config
  if (isDeployEnv) {
    // Check if Deno Deploy has database environment variables set
    const hasDeployDatabase = !!(
      Deno.env.get("PGHOST") ||
      Deno.env.get("PGDATABASE") ||
      Deno.env.get("DATABASE_URL")
    );

    if (hasDeployDatabase && !Deno.env.get("FORCE_DENO_KV")) {
      provider = "postgres";
      console.log(
        "[KV] Using PostgreSQL with Deno Deploy zero config. Set FORCE_DENO_KV=true to override.",
      );
    } else {
      provider = "deno";
      console.log(
        "[KV] Using Deno KV on Deploy. Attach a database for PostgreSQL support.",
      );
    }
  } else if (isProdEnv && !Deno.env.get("KV_PROVIDER")) {
    // Force postgres for production unless explicitly set to deno
    const hasPostgresUrl = !!(
      Deno.env.get("DATABASE_URL") || Deno.env.get("POSTGRES_URL")
    );
    if (hasPostgresUrl) {
      provider = "postgres";
      console.log(
        "[KV] Auto-detected postgres provider for production environment",
      );
    }
  }

  // For Deno Deploy, don't use local file paths
  let denoKvPath: string | undefined;
  if (isDeployEnv) {
    denoKvPath = undefined; // Use Deno Deploy's managed KV
    console.log("[KV] Using Deno Deploy managed KV (no local path)");
  } else {
    denoKvPath = Deno.env.get("DENO_KV_PATH") || "./data/kv.db";
  }

  return {
    provider,
    denoKvPath,
  };
}

/**
 * Creates a KV instance based on the provided configuration with fallback support
 * @param config KV configuration object
 * @returns Promise that resolves to a Kv instance
 */
export async function createKv(config?: Partial<KvConfig>): Promise<Deno.Kv> {
  const finalConfig = { ...getKvConfigFromEnv(), ...config };
  const isDeployEnv = isDenoDeploy();

  switch (finalConfig.provider) {
    case "postgres": {
      try {
        console.log("[KV] Using PostgreSQL KV provider with zero config");
        const pgKv = await openKvPostgres();
        return pgKv as unknown as Deno.Kv;
      } catch (error) {
        console.error(
          `[KV] PostgreSQL connection failed: ${(error as Error).message}`,
        );

        if (isDeployEnv) {
          console.warn(
            "[KV] Falling back to Deno Deploy managed KV due to PostgreSQL failure",
          );
          return await Deno.openKv();
        } else {
          throw error;
        }
      }
    }

    case "deno":
    default: {
      if (isDenoDeploy()) {
        console.log("[KV] Using Deno Deploy managed KV");
        return await Deno.openKv();
      } else {
        console.log(
          `[KV] Using Deno KV provider with path: ${finalConfig.denoKvPath}`,
        );
        return await Deno.openKv(finalConfig.denoKvPath);
      }
    }
  }
}

/**
 * Creates a KV instance using environment variables
 * This is the main entry point for the application
 */
export async function createKvFromEnv(): Promise<Deno.Kv> {
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
  const isDeployEnv = isDenoDeploy();

  // For PostgreSQL on Deploy, we rely on zero config (no manual validation needed)
  if (finalConfig.provider === "postgres" && !isDeployEnv) {
    const hasPostgresUrl = !!(
      Deno.env.get("DATABASE_URL") || Deno.env.get("POSTGRES_URL")
    );
    if (!hasPostgresUrl) {
      errors.push(
        "PostgreSQL URL is required for local development. " +
          "Set DATABASE_URL or POSTGRES_URL environment variable.",
      );
    }
  }

  if (
    finalConfig.provider === "deno" &&
    !isDeployEnv &&
    !finalConfig.denoKvPath
  ) {
    errors.push(
      "Deno KV path is required when using deno KV provider locally.",
    );
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
