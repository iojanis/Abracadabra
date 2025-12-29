// Logging Service for Abracadabra Server
// Provides structured logging using logtape with configurable formatters
// Includes Deno Deploy safeguards and enhanced error handling

import {
  configure,
  getConsoleSink,
  getLogger as getLogtapeLogger,
  type Logger,
  parseLogLevel,
} from "logtape";

import type { ConfigService } from "./config.ts";
import {
  isDenoDeploy,
  getEnvironmentInfo,
  getLoggerPrefix,
} from "../utils/environment.ts";

export type AbracadabraLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogContext {
  userId?: string;
  username?: string;
  docPath?: string;
  sessionId?: string;
  requestId?: string;
  duration?: number;
  statusCode?: number;
  method?: string;
  path?: string;
  userAgent?: string;
  ip?: string;
  [key: string]: any;
}

export class LoggingService {
  private initialized = false;
  private rootLogger?: Logger;

  /**
   * Initialize the logging system with Deno Deploy safeguards
   */
  async initialize(configService?: ConfigService): Promise<void> {
    if (this.initialized) {
      return;
    }

    const envInfo = getEnvironmentInfo();
    const startTime = Date.now();

    try {
      // Determine environment and log level with Deploy detection
      const isDevelopment = envInfo.isDevelopment;
      let logLevel: AbracadabraLogLevel = envInfo.isDevelopment
        ? "DEBUG"
        : "INFO";

      if (configService) {
        logLevel =
          (await configService.get<AbracadabraLogLevel>("logging.log_level")) ??
          "INFO";
      } else {
        // Fallback to environment variable
        logLevel =
          (Deno.env.get("ABRACADABRA_LOG_LEVEL") as AbracadabraLogLevel) ??
          "INFO";
      }

      // Add timeout protection for Deno Deploy
      if (envInfo.isDenoDeploy) {
        await Promise.race([
          this.configureLogtape(logLevel, isDevelopment),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Logging configuration timeout")),
              10000,
            ),
          ),
        ]);
      } else {
        await this.configureLogtape(logLevel, isDevelopment);
      }

      this.rootLogger = getLogtapeLogger(["abracadabra"]);
      this.initialized = true;

      const initTime = Date.now() - startTime;
      this.rootLogger.info("Logging service initialized", {
        logLevel,
        isDevelopment,
        initTime: `${initTime}ms`,
        environment: envInfo,
      });
    } catch (error) {
      const initTime = Date.now() - startTime;
      const errorMsg = `Failed to initialize logging service after ${initTime}ms: ${(error as Error).message}`;
      const logPrefix = getLoggerPrefix();

      console.error(`${logPrefix} ${errorMsg}`);

      // Don't throw in Deploy environment, use fallback console logging
      if (envInfo.isDenoDeploy) {
        console.warn(
          `${logPrefix} Falling back to console logging on Deno Deploy`,
        );
        this.initialized = true; // Mark as initialized to prevent retry loops
        return;
      }

      throw error;
    }
  }

  /**
   * Get a logger for a specific category
   */
  getLogger(category: string | string[]): Logger {
    if (!this.initialized) {
      throw new Error(
        "Logging service not initialized. Call initialize() first.",
      );
    }

    const categoryArray = Array.isArray(category) ? category : [category];
    return getLogtapeLogger(["abracadabra", ...categoryArray]);
  }

  /**
   * Get the root logger
   */
  getRootLogger(): Logger {
    if (!this.rootLogger) {
      throw new Error(
        "Logging service not initialized. Call initialize() first.",
      );
    }
    return this.rootLogger;
  }

  /**
   * Log an authentication event
   */
  logAuth(
    level: "info" | "warn" | "error",
    message: string,
    context: {
      userId?: string;
      username?: string;
      action: string;
      success?: boolean;
      reason?: string;
      ip?: string;
      userAgent?: string;
    },
  ): void {
    const logger = this.getLogger("auth");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log a document operation
   */
  logDocument(
    level: "info" | "warn" | "error",
    message: string,
    context: {
      userId?: string;
      docPath: string;
      operation: string;
      success?: boolean;
      duration?: number;
      error?: string;
    },
  ): void {
    const logger = this.getLogger("document");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log a collaboration event
   */
  logCollaboration(
    level: "info" | "warn" | "error",
    message: string,
    context: {
      userId?: string;
      docPath: string;
      event: string;
      connectionId?: string;
      collaboratorCount?: number;
      isReadOnly?: boolean;
    },
  ): void {
    const logger = this.getLogger("collaboration");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log an API request
   */
  logRequest(
    level: "info" | "warn" | "error",
    message: string,
    context: {
      method: string;
      path: string;
      statusCode: number;
      duration: number;
      userId?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
      responseSize?: number;
    },
  ): void {
    const logger = this.getLogger("api");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log a webhook event
   */
  logWebhook(
    level: "info" | "warn" | "error",
    message: string,
    context: {
      webhookId: string;
      docPath: string;
      event: string;
      url: string;
      statusCode?: number;
      duration?: number;
      attempt?: number;
      error?: string;
    },
  ): void {
    const logger = this.getLogger("webhook");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log a script execution
   */
  logScript(
    level: "info" | "warn" | "error",
    message: string,
    context: {
      scriptId: string;
      docPath: string;
      trigger: string;
      duration?: number;
      memoryUsed?: number;
      success?: boolean;
      error?: string;
    },
  ): void {
    const logger = this.getLogger("script");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log a performance metric
   */
  logPerformance(
    message: string,
    context: {
      operation: string;
      duration: number;
      resourceType?: string;
      resourceId?: string;
      memoryUsage?: number;
      cpuUsage?: number;
    },
  ): void {
    const logger = this.getLogger("performance");
    logger.info(message, { ...context, timestamp: new Date().toISOString() });
  }

  /**
   * Log a security event
   */
  logSecurity(
    level: "warn" | "error",
    message: string,
    context: {
      event: string;
      userId?: string;
      ip?: string;
      userAgent?: string;
      resource?: string;
      action?: string;
      blocked?: boolean;
      reason?: string;
    },
  ): void {
    const logger = this.getLogger("security");
    logger[level](message, { ...context, timestamp: new Date().toISOString() });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async configureLogtape(
    logLevel: AbracadabraLogLevel,
    isDevelopment: boolean,
  ): Promise<void> {
    const envInfo = getEnvironmentInfo();
    const logtapeLevel = this.mapLogLevel(logLevel);

    if (isDevelopment && !envInfo.isDenoDeploy) {
      // Development: Pretty console output with colors (not on Deploy)
      await configure({
        sinks: {
          console: getConsoleSink({
            formatter: (record) => {
              const timestamp = new Date(record.timestamp).toISOString();
              const level = record.level.toString().padEnd(5);
              const category = record.category.join(":");
              const message = record.message;

              // Format extra properties
              const extras =
                Object.keys(record.properties).length > 0
                  ? `\n  ${JSON.stringify(record.properties, null, 2)}`
                  : "";

              // Color coding for different levels
              const colors = {
                DEBUG: "\x1b[36m", // Cyan
                INFO: "\x1b[32m", // Green
                WARN: "\x1b[33m", // Yellow
                ERROR: "\x1b[31m", // Red
              };

              const reset = "\x1b[0m";
              const color =
                colors[record.level.toString() as keyof typeof colors] || "";

              return `${color}[${timestamp}] ${level} ${category}: ${message}${reset}${extras}`;
            },
          }),
        },
        filters: {},
        loggers: [
          {
            category: ["abracadabra"],
            level: logtapeLevel,
            sinks: ["console"],
          },
          {
            category: ["logtape", "meta"],
            level: parseLogLevel("error"),
            sinks: ["console"],
          },
        ],
      });
    } else {
      // Production/Deploy: Structured JSON output optimized for serverless
      const config = {
        sinks: {
          console: getConsoleSink({
            formatter: (record) => {
              interface LogEntry {
                timestamp: string;
                level: string;
                category: string;
                message: readonly unknown[];
                deployment?: { id: string | undefined; region: string | undefined; };
                [key: string]: any;
              }

              const baseLog: LogEntry = {
                timestamp: new Date(record.timestamp).toISOString(),
                level: record.level.toString(),
                category: record.category.join(":"),
                message: record.message,
                ...record.properties,
              };

              // Add Deploy-specific context
              if (envInfo.isDenoDeploy) {
                baseLog.deployment = {
                  id: envInfo.deploymentId?.slice(0, 8),
                  region: envInfo.region,
                };
              }

              return JSON.stringify(baseLog);
            },
          }),
        },
        filters: {},
        loggers: [
          {
            category: ["abracadabra"],
            level: logtapeLevel,
            sinks: ["console"],
          },
        ],
      };

      // Add meta logger configuration to suppress warnings
      config.loggers.push({
        category: ["logtape", "meta"],
        level: parseLogLevel("error"),
        sinks: ["console"],
      });

      try {
        await configure(config);
      } catch (configError) {
        if (envInfo.isDenoDeploy) {
          // Fallback to simple console logging on Deploy if configure fails
          const logPrefix = getLoggerPrefix();
          console.warn(
            `${logPrefix} LogTape configuration failed, using fallback: ${(configError as Error).message}`,
          );
          return;
        }
        throw configError;
      }
    }
  }

  private mapLogLevel(
    level: AbracadabraLogLevel,
  ): ReturnType<typeof parseLogLevel> {
    switch (level) {
      case "DEBUG":
        return parseLogLevel("debug");
      case "INFO":
        return parseLogLevel("info");
      case "WARN":
        return parseLogLevel("warning");
      case "ERROR":
        return parseLogLevel("error");
      default:
        return parseLogLevel("info");
    }
  }
}

// Singleton instance
let loggingService: LoggingService | null = null;

/**
 * Get the global logging service instance
 */
export function getLoggingService(): LoggingService {
  if (!loggingService) {
    throw new Error(
      "Logging service not initialized. Call createLoggingService() first.",
    );
  }
  return loggingService;
}

/**
 * Create and initialize the global logging service
 */
export async function createLoggingService(
  configService?: ConfigService,
): Promise<LoggingService> {
  if (loggingService) {
    return loggingService;
  }

  loggingService = new LoggingService();
  await loggingService.initialize(configService);
  return loggingService;
}

/**
 * Convenience function to get a logger for a specific category
 */
export function getLogger(category: string | string[]): Logger {
  return getLoggingService().getLogger(category);
}

/**
 * Request ID generator for tracking requests across logs
 */
export function generateRequestId(): string {
  return crypto.randomUUID().substring(0, 8);
}

/**
 * Helper to extract relevant request information for logging
 */
export function extractRequestContext(request: Request): LogContext {
  const url = new URL(request.url);

  const context: LogContext = {
    method: request.method,
    path: url.pathname,
    ip:
      request.headers.get("X-Forwarded-For") ||
      request.headers.get("X-Real-IP") ||
      "unknown",
  };

  const userAgent = request.headers.get("User-Agent");
  if (userAgent) {
    context.userAgent = userAgent;
  }

  return context;
}

/**
 * Helper to create a scoped logger with consistent context
 */
export function createScopedLogger(
  category: string | string[],
  context: LogContext,
) {
  const logger = getLogger(category);

  return {
    debug: (message: string, extraContext?: LogContext) =>
      logger.debug(message, { ...context, ...extraContext }),
    info: (message: string, extraContext?: LogContext) =>
      logger.info(message, { ...context, ...extraContext }),
    warn: (message: string, extraContext?: LogContext) =>
      logger.warn(message, { ...context, ...extraContext }),
    error: (message: string, extraContext?: LogContext) =>
      logger.error(message, { ...context, ...extraContext }),
  };
}
