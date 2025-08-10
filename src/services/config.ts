// Configuration Service for Abracadabra Server
// Manages runtime configuration using Deno KV as the unified datastore

import type { ConfigKey, ConfigValue, ServerConfig } from "../types/index.ts";
import { getLogger } from "logtape";

const logger = getLogger(["config"]);

export class ConfigService {
  private kv: Deno.Kv;
  private cache: Map<string, ConfigValue> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 30000; // 30 second cache

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  /**
   * Initialize configuration by loading from file and storing in KV
   * Called during server startup
   */
  async initialize(): Promise<void> {
    logger.info("Initializing configuration service");

    try {
      // Load configuration from file
      const configData = await this.loadConfigFromFile();

      // Store in KV if not already present
      await this.initializeKvConfig(configData);

      logger.info("Configuration service initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize configuration", {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Get configuration value by key
   * Supports dot-notation for nested values (e.g., "server.port")
   */
  async get<T extends ConfigValue = ConfigValue>(
    key: string,
  ): Promise<T | null> {
    // Check cache first
    const cached = this.getCached(key);
    if (cached !== null) {
      return cached as T;
    }

    try {
      const kvKey = ["config", key] as const;
      const result = await this.kv.get(kvKey);

      if (result.value !== null) {
        this.setCache(key, result.value as ConfigValue);
        return result.value as T;
      }

      return null;
    } catch (error) {
      logger.error("Failed to get configuration value", {
        key,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Set configuration value
   * Supports dot-notation for nested values
   */
  async set(key: string, value: ConfigValue): Promise<boolean> {
    try {
      const kvKey = ["config", key] as const;
      const result = await this.kv.set(kvKey, value);

      if (result.ok) {
        // Update cache
        this.setCache(key, value);
        logger.info("Configuration value updated", { key, value });
        return true;
      }

      logger.error("Failed to set configuration value", { key, value });
      return false;
    } catch (error) {
      logger.error("Error setting configuration value", {
        key,
        value,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get all configuration values
   */
  async getAll(): Promise<Partial<ServerConfig>> {
    const config: any = {};

    try {
      const configPrefix: ["config"] = ["config"];
      const entries = this.kv.list({ prefix: configPrefix });

      for await (const entry of entries) {
        const key = entry.key[1] as string; // Extract the config key
        const value = entry.value as ConfigValue;

        // Convert dot-notation back to nested object
        this.setNestedValue(config, key, value);
      }

      return config as Partial<ServerConfig>;
    } catch (error) {
      logger.error("Failed to get all configuration", {
        error: (error as Error).message,
      });
      return {};
    }
  }

  /**
   * Get typed configuration for a specific section
   */
  async getServerConfig(): Promise<Partial<ServerConfig>> {
    const [
      port,
      host,
      kvPath,
      jwtSecret,
      sessionTimeout,
      maxNestingDepth,
      maxDocumentSize,
      maxCollaborators,
      uploadStrategy,
      localUploadPath,
      s3Bucket,
      s3Region,
      logLevel,
      enablePublicDocs,
      enableWebhooks,
      enableScripting,
      enableFileUploads,
      rateLimitWindowMs,
      rateLimitMaxRequests,
    ] = await Promise.all([
      this.get<number>("server.port"),
      this.get<string>("server.host"),
      this.get<string>("database.kv_path"),
      this.get<string>("authentication.jwt_secret"),
      this.get<number>("authentication.session_timeout"),
      this.get<number>("documents.max_nesting_depth"),
      this.get<number>("documents.max_document_size"),
      this.get<number>("documents.max_collaborators_per_doc"),
      this.get<string>("file_storage.upload_strategy"),
      this.get<string>("file_storage.local_upload_path"),
      this.get<string>("file_storage.s3_bucket"),
      this.get<string>("file_storage.s3_region"),
      this.get<string>("logging.log_level"),
      this.get<boolean>("features.enable_public_documents"),
      this.get<boolean>("features.enable_webhooks"),
      this.get<boolean>("features.enable_scripting"),
      this.get<boolean>("features.enable_file_uploads"),
      this.get<number>("rate_limiting.rate_limit_window_ms"),
      this.get<number>("rate_limiting.rate_limit_max_requests"),
    ]);

    const config: Partial<ServerConfig> = {
      port: port ?? 8787,
      host: host ?? "0.0.0.0",
      jwt_secret: jwtSecret ?? "INSECURE_DEFAULT",
      session_timeout: sessionTimeout ?? 2592000,
      max_nesting_depth: maxNestingDepth ?? 10,
      max_document_size: maxDocumentSize ?? 10485760,
      max_collaborators_per_doc: maxCollaborators ?? 50,
      upload_strategy: (uploadStrategy as "local" | "s3") ?? "local",
      local_upload_path: localUploadPath ?? "./uploads",
      s3_region: s3Region ?? "us-east-1",
      log_level: (logLevel as "DEBUG" | "INFO" | "WARN" | "ERROR") ?? "INFO",
      enable_public_documents: enablePublicDocs ?? true,
      enable_webhooks: enableWebhooks ?? true,
      enable_scripting: enableScripting ?? true,
      enable_file_uploads: enableFileUploads ?? true,
      rate_limit_window_ms: rateLimitWindowMs ?? 3600000,
      rate_limit_max_requests: rateLimitMaxRequests ?? 100,
    };

    // Only add optional properties if they have values
    if (kvPath) {
      config.kv_path = kvPath;
    }
    if (s3Bucket) {
      config.s3_bucket = s3Bucket;
    }

    return config;
  }

  /**
   * Delete configuration value
   */
  async delete(key: string): Promise<boolean> {
    try {
      const kvKey = ["config", key] as const;
      await this.kv.delete(kvKey);

      // Remove from cache
      this.cache.delete(key);
      this.cacheExpiry.delete(key);

      logger.info("Configuration value deleted", { key });
      return true;
    } catch (error) {
      logger.error("Failed to delete configuration value", {
        key,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Clear all cached values
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheExpiry.clear();
    logger.debug("Configuration cache cleared");
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async loadConfigFromFile(): Promise<Record<string, any>> {
    const configPaths = [
      "./config/default.json",
      "./config/production.json",
      "./config/development.json",
    ];

    let config = {};

    for (const configPath of configPaths) {
      try {
        const configText = await Deno.readTextFile(configPath);
        const fileConfig = JSON.parse(configText);
        config = this.mergeDeep(config, fileConfig);
        logger.debug("Loaded configuration file", { configPath });
      } catch (error) {
        // Only default.json is required
        if (configPath.includes("default.json")) {
          logger.error("Required configuration file not found", {
            configPath,
            error: (error as Error).message,
          });
          throw error;
        }
        logger.debug("Optional configuration file not found", { configPath });
      }
    }

    // Apply environment variable overrides
    config = this.applyEnvironmentOverrides(config);

    return config;
  }

  private async initializeKvConfig(
    configData: Record<string, any>,
  ): Promise<void> {
    const flatConfig = this.flattenObject(configData);

    for (const [key, value] of Object.entries(flatConfig)) {
      const kvKey = ["config", key] as const;

      // Only set if key doesn't exist (don't override existing runtime config)
      const existing = await this.kv.get(kvKey);
      if (existing.value === null) {
        await this.kv.set(kvKey, value);
        logger.debug("Initialized configuration key", { key, value });
      }
    }
  }

  private applyEnvironmentOverrides(
    config: Record<string, any>,
  ): Record<string, any> {
    const envMappings = {
      ABRACADABRA_PORT: "server.port",
      ABRACADABRA_HOST: "server.host",
      ABRACADABRA_KV_PATH: "database.kv_path",
      ABRACADABRA_JWT_SECRET: "authentication.jwt_secret",
      ABRACADABRA_SESSION_TIMEOUT: "authentication.session_timeout",
      ABRACADABRA_UPLOAD_STRATEGY: "file_storage.upload_strategy",
      ABRACADABRA_S3_BUCKET: "file_storage.s3_bucket",
      ABRACADABRA_S3_REGION: "file_storage.s3_region",
      ABRACADABRA_S3_ACCESS_KEY: "file_storage.s3_access_key",
      ABRACADABRA_S3_SECRET_KEY: "file_storage.s3_secret_key",
      ABRACADABRA_LOG_LEVEL: "logging.log_level",
    };

    for (const [envVar, configPath] of Object.entries(envMappings)) {
      const envValue = Deno.env.get(envVar);
      if (envValue !== undefined) {
        this.setNestedValue(
          config,
          configPath,
          this.parseEnvironmentValue(envValue),
        );
        logger.debug("Applied environment override", {
          envVar,
          configPath,
          value: envValue,
        });
      }
    }

    return config;
  }

  private parseEnvironmentValue(value: string): ConfigValue {
    // Try to parse as JSON first (for booleans, numbers, etc.)
    try {
      return JSON.parse(value);
    } catch {
      // Return as string if JSON parsing fails
      return value;
    }
  }

  private flattenObject(
    obj: Record<string, any>,
    prefix = "",
  ): Record<string, ConfigValue> {
    const flattened: Record<string, ConfigValue> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        Object.assign(flattened, this.flattenObject(value, fullKey));
      } else {
        flattened[fullKey] = value as ConfigValue;
      }
    }

    return flattened;
  }

  private setNestedValue(obj: any, path: string, value: ConfigValue): void {
    const keys = path.split(".");
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  private mergeDeep(target: any, source: any): any {
    if (typeof target !== "object" || target === null) {
      return source;
    }
    if (typeof source !== "object" || source === null) {
      return target;
    }

    const result = { ...target };

    for (const key in source) {
      if (
        typeof source[key] === "object" &&
        source[key] !== null &&
        !Array.isArray(source[key])
      ) {
        result[key] = this.mergeDeep(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  private getCached(key: string): ConfigValue | null {
    const expiry = this.cacheExpiry.get(key);
    if (expiry && Date.now() > expiry) {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      return null;
    }
    return this.cache.get(key) ?? null;
  }

  private setCache(key: string, value: ConfigValue): void {
    this.cache.set(key, value);
    this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL_MS);
  }
}

// Singleton instance
let configService: ConfigService | null = null;

/**
 * Get the global configuration service instance
 */
export function getConfigService(): ConfigService {
  if (!configService) {
    throw new Error(
      "Configuration service not initialized. Call createConfigService() first.",
    );
  }
  return configService;
}

/**
 * Create and initialize the global configuration service
 */
export async function createConfigService(kv: Deno.Kv): Promise<ConfigService> {
  if (configService) {
    return configService;
  }

  configService = new ConfigService(kv);
  await configService.initialize();
  return configService;
}
