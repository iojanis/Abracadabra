import { getEnv, getCwd, isDeno, isTest as runtimeIsTest } from "./runtime.ts";

/**
 * Environment types
 */
export type Environment = "development" | "production" | "test";
export type DeploymentPlatform = "deno-deploy" | "local" | "docker" | "unknown";

/**
 * Environment configuration interface
 */
export interface EnvironmentInfo {
  isDenoDeploy: boolean;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  platform: DeploymentPlatform;
  nodeEnv: string;
  denoEnv: string;
  deploymentId?: string;
  region?: string;
  denoVersion: string | undefined;
  hasFileSystemAccess: boolean;
  supportsLocalStorage: boolean;
}

/**
 * Cached environment info to avoid repeated calculations
 */
let cachedEnvironmentInfo: EnvironmentInfo | null = null;

/**
 * Detect if running on Deno Deploy
 */
export function isDenoDeploy(): boolean {
  return !!(
    getEnv("DENO_DEPLOYMENT_ID") ||
    getEnv("DENO_REGION") ||
    globalThis.location?.hostname?.includes("deno.dev")
  );
}

/**
 * Detect if running in production environment
 */
export function isProduction(): boolean {
  const nodeEnv = getEnv("NODE_ENV");
  const denoEnv = getEnv("DENO_ENV");
  return nodeEnv === "production" || denoEnv === "production" || isDenoDeploy();
}

/**
 * Detect if running in development environment
 */
export function isDevelopment(): boolean {
  return !isProduction() && !isTest();
}

/**
 * Detect if running in test environment
 */
export function isTest(): boolean {
  const nodeEnv = getEnv("NODE_ENV");
  const denoEnv = getEnv("DENO_ENV");
  return nodeEnv === "test" || denoEnv === "test" || (typeof Deno !== "undefined" && Deno.env.get("TEST_RUN") === "true");
}

/**
 * Get the current environment type
 */
export function getEnvironment(): Environment {
  if (isTest()) return "test";
  if (isProduction()) return "production";
  return "development";
}

/**
 * Detect the deployment platform
 */
export function getDeploymentPlatform(): DeploymentPlatform {
  if (isDenoDeploy()) return "deno-deploy";
  if (Deno.env.get("DOCKER_CONTAINER")) return "docker";
  if (getEnv("KUBERNETES_SERVICE_HOST")) return "docker"; // Kubernetes
  return "local";
}

/**
 * Check if file system access is available
 */
export function hasFileSystemAccess(): boolean {
  if (isDenoDeploy()) return false;

  try {
    // Try to access the current working directory
    getCwd();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if local storage (file writes) is supported
 */
export function supportsLocalStorage(): boolean {
  if (isDenoDeploy()) return false;

  if (isDeno) {
    try {
      // @ts-ignore: Deno global usage
      const status = Deno.permissions.querySync({ name: "write" });
      return status.state === "granted";
    } catch {
      return false;
    }
  }
  // Assume true for Node/Bun unless readonly fs
  return true;
}

/**
 * Get comprehensive environment information
 */
export function getEnvironmentInfo(): EnvironmentInfo {
  if (cachedEnvironmentInfo) {
    return cachedEnvironmentInfo;
  }

  const info: EnvironmentInfo = {
    isDenoDeploy: isDenoDeploy(),
    isProduction: isProduction(),
    isDevelopment: isDevelopment(),
    isTest: isTest(),
    platform: getDeploymentPlatform(),
    nodeEnv: getEnv("NODE_ENV") || "development",
    denoEnv: getEnv("DENO_ENV") || "development",
    denoVersion: isDeno ? (Deno as any).version.deno : undefined,
    hasFileSystemAccess: hasFileSystemAccess(),
    supportsLocalStorage: supportsLocalStorage(),
  };

  const deploymentId = getEnv("DENO_DEPLOYMENT_ID");
  if (deploymentId) {
    info.deploymentId = deploymentId;
  }

  const region = getEnv("DENO_REGION");
  if (region) {
    info.region = region;
  }

  cachedEnvironmentInfo = info;
  return info;
}

/**
 * Get a short deployment identifier for logging
 */
export function getDeploymentId(): string {
  const deploymentId = getEnv("DENO_DEPLOYMENT_ID");
  if (deploymentId) {
    return deploymentId.slice(0, 8);
  }

  const platform = getDeploymentPlatform();
  return platform === "local" ? "local" : "unknown";
}

/**
 * Get environment-specific configuration defaults
 */
export function getEnvironmentDefaults() {
  const env = getEnvironmentInfo();

  return {
    // Logging defaults
    logLevel: env.isDevelopment ? "DEBUG" : "INFO",
    logFormat: env.isDevelopment ? "pretty" : "json",

    // Database defaults
    kvProvider: env.isDenoDeploy ? "deno" : "deno", // Can be overridden

    // Storage defaults
    useLocalStorage: env.supportsLocalStorage,

    // Performance defaults
    connectionPoolSize: env.isDenoDeploy ? 1 : 5,
    requestTimeout: env.isDenoDeploy ? 30000 : 60000,

    // Security defaults
    trustProxy: env.isDenoDeploy || env.platform === "docker",
  };
}

/**
 * Check if a specific feature is supported in the current environment
 */
export function isFeatureSupported(feature: string): boolean {
  const env = getEnvironmentInfo();

  switch (feature) {
    case "local-file-storage":
      return env.supportsLocalStorage;

    case "file-uploads":
      return env.supportsLocalStorage || hasS3Configuration();

    case "websockets":
      return true; // Supported everywhere

    case "background-tasks":
      return !env.isDenoDeploy; // Limited on Deploy

    case "file-watching":
      return env.isDevelopment && env.hasFileSystemAccess;

    default:
      return true;
  }
}

/**
 * Check if S3 configuration is available
 */
function hasS3Configuration(): boolean {
  return !!(
    getEnv("S3_BUCKET") ||
    getEnv("AWS_S3_BUCKET") ||
    getEnv("uploads.s3_bucket")
  );
}

/**
 * Get a formatted environment description for logging
 */
export function getEnvironmentDescription(): string {
  const env = getEnvironmentInfo();
  const parts = [
    env.platform,
    env.isProduction ? "production" : "development",
  ];

  if (env.deploymentId) {
    parts.push(`deploy:${env.deploymentId.slice(0, 8)}`);
  }

  if (env.region) {
    parts.push(`region:${env.region}`);
  }

  return parts.join(" | ");
}

/**
 * Validate environment configuration
 */
export function validateEnvironment(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const env = getEnvironmentInfo();

  // Check for required environment variables in production
  if (env.isProduction) {
    if (!getEnv("NODE_ENV") && !getEnv("DENO_ENV")) {
      errors.push("NODE_ENV or DENO_ENV should be set to 'production'");
    }
  }

  // Check for Deno Deploy specific requirements
  if (env.isDenoDeploy) {
    if (!env.deploymentId) {
      errors.push("DENO_DEPLOYMENT_ID not found in Deno Deploy environment");
    }
  }

  // Check for development requirements
  if (env.isDevelopment) {
    if (!env.hasFileSystemAccess) {
      errors.push("File system access not available in development");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Force refresh the cached environment info
 */
export function refreshEnvironmentInfo(): EnvironmentInfo {
  cachedEnvironmentInfo = null;
  return getEnvironmentInfo();
}

/**
 * Get environment-specific logger prefix
 */
export function getLoggerPrefix(): string {
  const env = getEnvironmentInfo();

  if (env.isDenoDeploy) {
    return `[Deploy:${getDeploymentId()}]`;
  }

  if (env.platform === "docker") {
    return "[Docker]";
  }

  return "[Local]";
}
