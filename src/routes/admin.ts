// Admin API Routes for Abracadabra Server
// Handles system configuration, user management, and administrative operations

import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth.ts";
import type {
  ApiError,
  ApiResponse,
  ConfigValue,
  DocumentMetadataObject,
  ServerConfig,
  SessionObject,
  UserObject,
  UserSettings,
} from "../types/index.ts";
import type { ConfigService } from "../services/config.ts";
import type { DocumentService } from "../services/documents.ts";
import type { PermissionService } from "../services/permissions.ts";
import { getLogger } from "../services/logging.ts";

let adminLogger: ReturnType<typeof getLogger> | null = null;

function getDefaultUserSettings(): UserSettings {
  return {
    defaultPermissions: "EDITOR",
    emailNotifications: true,
    maxNestingDepth: 10,
  };
}

function mergeUserSettings(
  existing: UserSettings | undefined,
  updates: Partial<UserSettings> | undefined,
): UserSettings {
  const defaults = getDefaultUserSettings();
  const base = existing || defaults;

  if (!updates) {
    return {
      defaultPermissions: base.defaultPermissions || defaults.defaultPermissions!,
      emailNotifications: base.emailNotifications ?? defaults.emailNotifications!,
      maxNestingDepth: base.maxNestingDepth || defaults.maxNestingDepth!,
    };
  }

  return {
    defaultPermissions: updates.defaultPermissions ||
      base.defaultPermissions ||
      defaults.defaultPermissions!,
    emailNotifications: updates.emailNotifications ??
      base.emailNotifications ??
      defaults.emailNotifications!,
    maxNestingDepth: updates.maxNestingDepth ||
      base.maxNestingDepth ||
      defaults.maxNestingDepth!,
  };
}

function getAdminLogger() {
  if (!adminLogger) {
    adminLogger = getLogger(["routes", "admin"]);
  }
  return adminLogger;
}

// Validation schemas
const configUpdateSchema = z.object({
  port: z.number().min(1).max(65535).optional(),
  host: z.string().min(1).optional(),
  jwt_secret: z.string().min(32).optional(),
  session_timeout: z
    .number()
    .min(300)
    .max(86400 * 30)
    .optional(), // 5 min to 30 days
  max_nesting_depth: z.number().min(1).max(50).optional(),
  max_document_size: z
    .number()
    .min(1024)
    .max(1024 * 1024 * 100)
    .optional(), // 1KB to 100MB
  max_collaborators_per_doc: z.number().min(1).max(1000).optional(),
  upload_strategy: z.enum(["local", "s3"]).optional(),
  local_upload_path: z.string().optional(),
  s3_bucket: z.string().optional(),
  s3_region: z.string().optional(),
  s3_access_key: z.string().optional(),
  s3_secret_key: z.string().optional(),
  log_level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional(),
  enable_public_documents: z.boolean().optional(),
  enable_webhooks: z.boolean().optional(),
  enable_scripting: z.boolean().optional(),
  enable_file_uploads: z.boolean().optional(),
  rate_limit_window_ms: z.number().min(1000).max(3600000).optional(), // 1s to 1h
  rate_limit_max_requests: z.number().min(1).max(10000).optional(),
});

const userUpdateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
  settings: z
    .object({
      defaultPermissions: z
        .enum(["NONE", "VIEWER", "COMMENTER", "EDITOR", "ADMIN", "OWNER"])
        .optional(),
      emailNotifications: z.boolean().optional(),
      maxNestingDepth: z.number().min(1).max(20).optional(),
    })
    .optional(),
});

const bulkActionSchema = z.object({
  action: z.enum(["cleanup", "migrate", "backup", "restore"]),
  options: z.record(z.any()).optional(),
});

export class AdminRoutes {
  private kv: Deno.Kv;
  private app: Hono;
  private configService: ConfigService;
  private documentService: DocumentService;
  private permissionService: PermissionService;

  constructor(
    kv: Deno.Kv,
    configService: ConfigService,
    documentService: DocumentService,
    permissionService: PermissionService,
  ) {
    this.kv = kv;
    this.configService = configService;
    this.documentService = documentService;
    this.permissionService = permissionService;
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes() {
    // Middleware to require admin permissions
    this.app.use("*", requireAdmin());

    // Get system configuration
    this.app.get("/config", async (c) => {
      try {
        const config = await this.configService.getServerConfig();

        // Remove sensitive information
        const sanitizedConfig = { ...config };
        delete sanitizedConfig.jwt_secret;
        delete sanitizedConfig.s3_access_key;
        delete sanitizedConfig.s3_secret_key;

        return c.json({
          data: { config: sanitizedConfig },
        });
      } catch (error) {
        getAdminLogger().error("Error getting system configuration", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get system configuration",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Update system configuration
    this.app.put(
      "/config",
      validator("json", (value, c) => {
        const result = configUpdateSchema.safeParse(value);
        if (!result.success) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Validation failed",
                details: result.error.issues,
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }
        return result.data;
      }),
      async (c) => {
        try {
          const data = c.req.valid("json");
          const userId = (c as any).get("userId") as string;

          getAdminLogger().info("System configuration update", {
            userId,
            keys: Object.keys(data),
          });

          // Update configuration
          const updates = [];
          for (const [key, value] of Object.entries(data)) {
            await this.configService.set(key, value);
            updates.push({ key, value });
          }

          getAdminLogger().info("System configuration updated", {
            userId,
            updates: updates.length,
          });

          return c.json({
            data: {
              message: "Configuration updated successfully",
              updates: updates.length,
            },
          });
        } catch (error) {
          getAdminLogger().error("Error updating system configuration", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to update system configuration",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Get specific configuration value
    this.app.get("/config/:key", async (c) => {
      try {
        const key = c.req.param("key");
        const value = await this.configService.get(key);

        // Don't return sensitive keys
        const sensitiveKeys = ["jwt_secret", "s3_access_key", "s3_secret_key"];
        if (sensitiveKeys.includes(key)) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Cannot retrieve sensitive configuration values",
                timestamp: new Date().toISOString(),
              },
            },
            403,
          );
        }

        return c.json({
          data: { key, value },
        });
      } catch (error) {
        getAdminLogger().error("Error getting configuration value", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get configuration value",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Set specific configuration value
    this.app.put("/config/:key", async (c) => {
      try {
        const key = c.req.param("key");
        const body = await c.req.json();
        const value = body.value;

        if (value === undefined) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Value is required",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        await this.configService.set(key, value);

        getAdminLogger().info("Configuration value updated", {
          key,
          userId: (c as any).get("userId") as string,
        });

        return c.json({
          data: { message: "Configuration value updated successfully" },
        });
      } catch (error) {
        getAdminLogger().error("Error setting configuration value", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to set configuration value",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Get system statistics
    this.app.get("/stats", async (c) => {
      try {
        // Get document statistics
        const documentStats = await this.documentService.getDocumentStats();

        // Count users
        let userCount = 0;
        let activeUserCount = 0;
        const userIter = this.kv.list({ prefix: ["users"] });
        for await (const entry of userIter) {
          const user = entry.value as UserObject;
          userCount++;
          if (user.isActive) activeUserCount++;
        }

        // Count sessions
        let sessionCount = 0;
        let activeSessionCount = 0;
        const now = Date.now();
        const sessionIter = this.kv.list({ prefix: ["sessions"] });
        for await (const entry of sessionIter) {
          const session = entry.value as SessionObject;
          sessionCount++;
          if (session.expiresAt.getTime() > now) activeSessionCount++;
        }

        // System uptime (approximation)
        const uptime = Date.now(); // This would need to be tracked from server start

        return c.json({
          data: {
            stats: {
              documents: documentStats,
              users: {
                total: userCount,
                active: activeUserCount,
              },
              sessions: {
                total: sessionCount,
                active: activeSessionCount,
              },
              system: {
                uptime,
                timestamp: new Date().toISOString(),
              },
            },
          },
        });
      } catch (error) {
        getAdminLogger().error("Error getting system statistics", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get system statistics",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // List all users
    this.app.get("/users", async (c) => {
      try {
        const limit = parseInt(c.req.query("limit") || "50");
        const offset = parseInt(c.req.query("offset") || "0");
        const search = c.req.query("search");
        const activeOnly = c.req.query("activeOnly") === "true";

        const users: UserObject[] = [];
        const iter = this.kv.list({ prefix: ["users"] });

        for await (const entry of iter) {
          const user = entry.value as UserObject;

          // Apply filters
          if (activeOnly && !user.isActive) continue;

          if (search) {
            const searchLower = search.toLowerCase();
            const matchesSearch = user.username.toLowerCase().includes(searchLower) ||
              user.displayName.toLowerCase().includes(searchLower) ||
              (user.email && user.email.toLowerCase().includes(searchLower));

            if (!matchesSearch) continue;
          }

          users.push(user);
        }

        // Sort by creation date
        users.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        // Paginate
        const paginatedUsers = users.slice(offset, offset + limit);

        // Remove sensitive information
        const sanitizedUsers = paginatedUsers.map((user) => {
          const { hashedPassword: _, ...sanitizedUser } = user;
          return sanitizedUser;
        });

        return c.json({
          data: {
            users: sanitizedUsers,
            meta: {
              limit,
              offset,
              total: users.length,
              hasMore: offset + limit < users.length,
            },
          },
        });
      } catch (error) {
        getAdminLogger().error("Error listing users", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to list users",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Get specific user
    this.app.get("/users/:username", async (c) => {
      try {
        const username = c.req.param("username");
        const userResult = await this.kv.get(["users", username]);
        const user = userResult.value as UserObject | null;

        if (!user) {
          return c.json(
            {
              error: {
                code: "USER_NOT_FOUND",
                message: "User not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        // Remove sensitive information
        const { hashedPassword: _, ...sanitizedUser } = user;

        return c.json({
          data: { user: sanitizedUser },
        });
      } catch (error) {
        getAdminLogger().error("Error getting user", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get user",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Update user
    this.app.put(
      "/users/:username",
      validator("json", (value, c) => {
        const result = userUpdateSchema.safeParse(value);
        if (!result.success) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Validation failed",
                details: result.error.issues,
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }
        return result.data;
      }),
      async (c) => {
        try {
          const username = c.req.param("username");
          const data = c.req.valid("json");
          const adminUserId = (c as any).get("userId") as string;

          const userResult = await this.kv.get(["users", username]);
          const user = userResult.value as UserObject | null;

          if (!user) {
            return c.json(
              {
                error: {
                  code: "USER_NOT_FOUND",
                  message: "User not found",
                  timestamp: new Date().toISOString(),
                },
              },
              404,
            );
          }

          // Update user
          const updatedUser: UserObject = {
            ...user,
            ...(data.displayName && { displayName: data.displayName }),
            ...(data.email !== undefined && { email: data.email }),
            ...(data.isActive !== undefined && { isActive: data.isActive }),
            settings: mergeUserSettings(
              user.settings,
              data.settings
                ? {
                  ...(data.settings.defaultPermissions !== undefined && {
                    defaultPermissions: data.settings.defaultPermissions,
                  }),
                  ...(data.settings.emailNotifications !== undefined && {
                    emailNotifications: data.settings.emailNotifications,
                  }),
                  ...(data.settings.maxNestingDepth !== undefined && {
                    maxNestingDepth: data.settings.maxNestingDepth,
                  }),
                }
                : undefined,
            ),
            updatedAt: new Date(),
          };

          await this.kv.set(["users", username], updatedUser);

          getAdminLogger().info("User updated by admin", {
            username,
            adminUserId,
            changes: Object.keys(data),
          });

          // Remove sensitive information
          const { hashedPassword: _, ...sanitizedUser } = updatedUser;

          return c.json({
            data: { user: sanitizedUser },
          });
        } catch (error) {
          getAdminLogger().error("Error updating user", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to update user",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Delete user
    this.app.delete("/users/:username", async (c) => {
      try {
        const username = c.req.param("username");
        const adminUserId = (c as any).get("userId") as string;

        const userResult = await this.kv.get(["users", username]);
        const user = userResult.value as UserObject | null;

        if (!user) {
          return c.json(
            {
              error: {
                code: "USER_NOT_FOUND",
                message: "User not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        // Delete user and all their sessions
        const batch = this.kv.atomic();
        batch.delete(["users", username]);

        // Delete all user sessions
        const sessionIter = this.kv.list({ prefix: ["sessions"] });
        for await (const entry of sessionIter) {
          const session = entry.value as SessionObject;
          if (session.userId === user.id) {
            batch.delete(entry.key);
          }
        }

        await batch.commit();

        getAdminLogger().warn("User deleted by admin", {
          username,
          userId: user.id,
          adminUserId,
        });

        return c.json({
          data: { message: "User deleted successfully" },
        });
      } catch (error) {
        getAdminLogger().error("Error deleting user", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to delete user",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // List all sessions
    this.app.get("/sessions", async (c) => {
      try {
        const limit = parseInt(c.req.query("limit") || "100");
        const offset = parseInt(c.req.query("offset") || "0");
        const activeOnly = c.req.query("activeOnly") === "true";

        const sessions: (SessionObject & { username?: string })[] = [];
        const now = Date.now();

        // Get all sessions
        const sessionIter = this.kv.list({ prefix: ["sessions"] });
        for await (const entry of sessionIter) {
          const session = entry.value as SessionObject;

          if (activeOnly && session.expiresAt.getTime() <= now) continue;

          // Find username for this session
          const userIter = this.kv.list({ prefix: ["users"] });
          for await (const userEntry of userIter) {
            const user = userEntry.value as UserObject;
            if (user.id === session.userId) {
              sessions.push({
                ...session,
                username: user.username,
              });
              break;
            }
          }
        }

        // Sort by creation date
        sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        // Paginate
        const paginatedSessions = sessions.slice(offset, offset + limit);

        return c.json({
          data: {
            sessions: paginatedSessions,
            meta: {
              limit,
              offset,
              total: sessions.length,
              hasMore: offset + limit < sessions.length,
            },
          },
        });
      } catch (error) {
        getAdminLogger().error("Error listing sessions", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to list sessions",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Revoke session
    this.app.delete("/sessions/:sessionId", async (c) => {
      try {
        const sessionId = c.req.param("sessionId");
        const adminUserId = (c as any).get("userId") as string;

        const sessionResult = await this.kv.get(["sessions", sessionId]);
        const session = sessionResult.value as SessionObject | null;

        if (!session) {
          return c.json(
            {
              error: {
                code: "USER_NOT_FOUND",
                message: "Session not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        await this.kv.delete(["sessions", sessionId]);

        getAdminLogger().info("Session revoked by admin", {
          sessionId,
          targetUserId: session.userId,
          adminUserId,
        });

        return c.json({
          data: { message: "Session revoked successfully" },
        });
      } catch (error) {
        getAdminLogger().error("Error revoking session", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to revoke session",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // System maintenance operations
    this.app.post(
      "/maintenance",
      validator("json", (value, c) => {
        const result = bulkActionSchema.safeParse(value);
        if (!result.success) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Validation failed",
                details: result.error.issues,
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }
        return result.data;
      }),
      async (c) => {
        try {
          const data = c.req.valid("json");
          const adminUserId = (c as any).get("userId") as string;

          getAdminLogger().info("Maintenance operation started", {
            action: data.action,
            adminUserId,
            options: data.options,
          });

          let result: any = {};

          switch (data.action) {
            case "cleanup":
              // Clean up expired sessions
              const sessionCleanup = await this.cleanupExpiredSessions();

              // Clean up documents
              const documentCleanup = await this.documentService.cleanupDocuments();

              result = {
                sessionsRemoved: sessionCleanup,
                documentsProcessed: documentCleanup.documentsRemoved,
                storageFreed: documentCleanup.storageFreed,
              };
              break;

            default:
              return c.json(
                {
                  error: {
                    code: "INVALID_INPUT",
                    message: `Unsupported maintenance action: ${data.action}`,
                    timestamp: new Date().toISOString(),
                  },
                },
                400,
              );
          }

          getAdminLogger().info("Maintenance operation completed", {
            action: data.action,
            adminUserId,
            result,
          });

          return c.json({
            data: {
              action: data.action,
              result,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          getAdminLogger().error("Error during maintenance operation", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Maintenance operation failed",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // System health check
    this.app.get("/health", async (c) => {
      try {
        // Check Deno KV connection
        const kvTest = await this.kv.get(["health", "test"]);
        const kvHealthy = kvTest !== null;

        // Check configuration service
        let configHealthy = true;
        try {
          await this.configService.get("port");
        } catch {
          configHealthy = false;
        }

        // Get basic stats
        const stats = {
          timestamp: new Date().toISOString(),
          services: {
            denoKv: kvHealthy ? "healthy" : "unhealthy",
            configuration: configHealthy ? "healthy" : "unhealthy",
          },
        };

        const isHealthy = kvHealthy && configHealthy;

        return c.json(
          {
            data: {
              status: isHealthy ? "healthy" : "degraded",
              stats,
            },
          },
          isHealthy ? 200 : 503,
        );
      } catch (error) {
        getAdminLogger().error("Error checking system health", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Health check failed",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });
  }

  private async cleanupExpiredSessions(): Promise<number> {
    let cleaned = 0;
    const now = Date.now();

    try {
      const iter = this.kv.list({ prefix: ["sessions"] });
      const batch = this.kv.atomic();
      let batchSize = 0;

      for await (const entry of iter) {
        const session = entry.value as SessionObject;

        if (session.expiresAt.getTime() <= now) {
          batch.delete(entry.key);
          cleaned++;
          batchSize++;

          // Commit in batches of 100
          if (batchSize >= 100) {
            await batch.commit();
            batchSize = 0;
          }
        }
      }

      // Commit remaining items
      if (batchSize > 0) {
        await batch.commit();
      }
    } catch (error) {
      getAdminLogger().error("Error during session cleanup", {
        error: (error as Error).message,
        cleaned,
      });
    }

    return cleaned;
  }

  getApp(): Hono {
    return this.app;
  }
}

export function createAdminRoutes(
  kv: Deno.Kv,
  configService: ConfigService,
  documentService: DocumentService,
  permissionService: PermissionService,
): Hono {
  const adminRoutes = new AdminRoutes(
    kv,
    configService,
    documentService,
    permissionService,
  );
  return adminRoutes.getApp();
}
