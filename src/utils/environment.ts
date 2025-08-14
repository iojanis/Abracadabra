// Environment Detection Utility for Abracadabra Server
// Centralized environment checks and configuration

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
  denoVersion: string;
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
    Deno.env.get("DENO_DEPLOYMENT_ID") ||
    Deno.env.get("DENO_REGION") ||
    globalThis.location?.hostname?.includes("deno.dev")
  );
}

/**
 * Detect if running in production environment
 */
export function isProduction(): boolean {
  const nodeEnv = Deno.env.get("NODE_ENV");
  const denoEnv = Deno.env.get("DENO_ENV");
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
  const nodeEnv = Deno.env.get("NODE_ENV");
  const denoEnv = Deno.env.get("DENO_ENV");
  return nodeEnv === "test" || denoEnv === "test";
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
  if (Deno.env.get("KUBERNETES_SERVICE_HOST")) return "docker"; // Kubernetes
  return "local";
}

/**
 * Check if file system access is available
 */
export function hasFileSystemAccess(): boolean {
  if (isDenoDeploy()) return false;

  try {
    // Try to access the current working directory
    Deno.cwd();
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

  try {
    // Try to check write permissions
    const status = Deno.permissions.querySync({ name: "write" });
    return status.state === "granted";
  } catch {
    return false;
  }
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
    nodeEnv: Deno.env.get("NODE_ENV") || "development",
    denoEnv: Deno.env.get("DENO_ENV") || "development",
    deploymentId: Deno.env.get("DENO_DEPLOYMENT_ID"),
    region: Deno.env.get("DENO_REGION"),
    denoVersion: Deno.version.deno,
    hasFileSystemAccess: hasFileSystemAccess(),
    supportsLocalStorage: supportsLocalStorage(),
  };

  cachedEnvironmentInfo = info;
  return info;
}

/**
 * Get a short deployment identifier for logging
 */
export function getDeploymentId(): string {
  const deploymentId = Deno.env.get("DENO_DEPLOYMENT_ID");
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
    Deno.env.get("S3_BUCKET") ||
    Deno.env.get("AWS_S3_BUCKET") ||
    Deno.env.get("uploads.s3_bucket")
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
    if (!Deno.env.get("NODE_ENV") && !Deno.env.get("DENO_ENV")) {
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
