// Authentication API Routes for Abracadabra Server
// Handles user registration, login, logout, and profile management

import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { hash, verify } from "../utils/password.ts";
import type {
  ApiError,
  ApiResponse,
  PermissionLevel,
  SessionObject,
  UserObject,
  UserSettings,
} from "../types/index.ts";
import { getLogger } from "../services/logging.ts";
import { AuthService } from "../auth.ts";

let logger: ReturnType<typeof getLogger> | null = null;

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
      defaultPermissions:
        base.defaultPermissions || defaults.defaultPermissions!,
      emailNotifications:
        base.emailNotifications ?? defaults.emailNotifications!,
      maxNestingDepth: base.maxNestingDepth || defaults.maxNestingDepth!,
    };
  }

  return {
    defaultPermissions:
      updates.defaultPermissions ||
      base.defaultPermissions ||
      defaults.defaultPermissions!,
    emailNotifications:
      updates.emailNotifications ??
      base.emailNotifications ??
      defaults.emailNotifications!,
    maxNestingDepth:
      updates.maxNestingDepth ||
      base.maxNestingDepth ||
      defaults.maxNestingDepth!,
  };
}

function getAuthLogger() {
  if (!logger) {
    logger = getLogger(["routes", "auth"]);
  }
  return logger;
}

// Validation schemas
const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(50, "Username must be at most 50 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username can only contain letters, numbers, underscores, and hyphens",
    ),
  email: z.string().email("Invalid email address").optional(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
  displayName: z
    .string()
    .min(1, "Display name is required")
    .max(100, "Display name must be at most 100 characters"),
});

const loginSchema = z.object({
  identifier: z.string().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
});

const profileUpdateSchema = z.object({
  displayName: z
    .string()
    .min(1, "Display name is required")
    .max(100, "Display name must be at most 100 characters")
    .optional(),
  email: z.string().email("Invalid email address").optional(),
  avatar: z.string().url("Avatar must be a valid URL").optional(),
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

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z
    .string()
    .min(8, "New password must be at least 8 characters")
    .max(128, "New password must be at most 128 characters"),
});

export class AuthRoutes {
  private kv: Deno.Kv;
  private authService: AuthService;
  private app: Hono;

  constructor(kv: Deno.Kv, authService: AuthService) {
    this.kv = kv;
    this.authService = authService;
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes() {
    // User registration
    this.app.post(
      "/register",
      validator("json", (value, c) => {
        const result = registerSchema.safeParse(value);
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
          const data = await c.req.json();

          getAuthLogger().info("User registration attempt", {
            username: data.username,
            email: data.email,
          });

          // Use AuthService for registration
          const result = await this.authService.register({
            username: data.username,
            email: data.email,
            password: data.password,
            displayName: data.displayName,
          });

          if (!result.success) {
            return c.json(
              {
                error: {
                  code: result.error!.code,
                  message: result.error!.message,
                  timestamp: new Date().toISOString(),
                },
              },
              result.error!.code === "DUPLICATE_RESOURCE" ? 409 : 400,
            );
          }

          getAuthLogger().info("User registered successfully", {
            userId: result.user!.id,
            username: result.user!.username,
          });

          return c.json(
            {
              data: {
                user: {
                  id: result.user!.id,
                  username: result.user!.username,
                  email: result.user!.email,
                  displayName: result.user!.displayName,
                  createdAt: result.user!.createdAt,
                  updatedAt: result.user!.updatedAt,
                  isActive: result.user!.isActive,
                  settings: result.user!.settings,
                },
                sessionToken: result.session!.id,
              },
            },
            201,
          );
        } catch (error) {
          getAuthLogger().error("Registration error", {
            error: (error as Error).message,
            stack: (error as Error).stack,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to register user",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // User login
    this.app.post(
      "/login",
      validator("json", (value, c) => {
        const result = loginSchema.safeParse(value);
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

          getAuthLogger().info("🔍 DEBUG: Raw request data received", {
            identifier: data.identifier,
            passwordLength: data.password?.length || 0,
            hasPassword: !!data.password,
            requestKeys: Object.keys(data),
          });

          getAuthLogger().info("Login attempt", {
            identifier: data.identifier,
          });

          // Use AuthService for login
          getAuthLogger().info("🔍 DEBUG: Calling auth service login", {
            identifier: data.identifier,
            passwordProvided: !!data.password,
          });

          const result = await this.authService.login({
            identifier: data.identifier,
            password: data.password,
          });

          getAuthLogger().info("🔍 DEBUG: Auth service response", {
            success: result.success,
            hasUser: !!result.user,
            hasSession: !!result.session,
            errorCode: result.error?.code,
            errorMessage: result.error?.message,
          });

          if (!result.success) {
            getAuthLogger().error("🔍 DEBUG: Login failed", {
              identifier: data.identifier,
              errorCode: result.error!.code,
              errorMessage: result.error!.message,
            });

            return c.json(
              {
                error: {
                  code: result.error!.code,
                  message: result.error!.message,
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          getAuthLogger().info("User logged in successfully", {
            userId: result.user!.id,
            username: result.user!.username,
          });

          return c.json({
            data: {
              user: {
                id: result.user!.id,
                username: result.user!.username,
                email: result.user!.email,
                displayName: result.user!.displayName,
                createdAt: result.user!.createdAt,
                updatedAt: result.user!.updatedAt,
                isActive: result.user!.isActive,
                settings: result.user!.settings,
              },
              sessionToken: result.session!.id,
            },
          });
        } catch (error) {
          getAuthLogger().error("🔍 DEBUG: Login route error", {
            error: (error as Error).message,
            stack: (error as Error).stack,
          });
          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Login failed",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // User logout
    this.app.post("/logout", async (c) => {
      try {
        const sessionToken =
          c.req.header("authorization")?.replace("Bearer ", "") ||
          c.req.header("x-session-token");

        if (sessionToken) {
          await this.kv.delete(["sessions", sessionToken]);
          getAuthLogger().info("User logged out", {
            sessionToken: sessionToken.substring(0, 8),
          });
        }

        return c.json({
          data: { message: "Logged out successfully" },
        });
      } catch (error) {
        getAuthLogger().error("Logout error", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Logout failed",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Get current user profile
    this.app.get("/profile", async (c) => {
      try {
        const sessionToken =
          c.req.header("authorization")?.replace("Bearer ", "") ||
          c.req.header("x-session-token");

        if (!sessionToken) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Session token required",
                timestamp: new Date().toISOString(),
              },
            },
            401,
          );
        }

        const sessionResult = await this.kv.get(["sessions", sessionToken]);
        const session = sessionResult.value as SessionObject | null;

        if (!session || session.expiresAt.getTime() <= Date.now()) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Invalid or expired session",
                timestamp: new Date().toISOString(),
              },
            },
            401,
          );
        }

        // Get user
        const iter = this.kv.list({ prefix: ["users"] });
        let user: UserObject | null = null;
        for await (const entry of iter) {
          const u = entry.value as UserObject;
          if (u.id === session.userId) {
            user = u;
            break;
          }
        }

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

        // Return user data without password
        const { hashedPassword: _, ...userResponse } = user;

        return c.json({
          data: { user: userResponse },
        });
      } catch (error) {
        getAuthLogger().error("Profile retrieval error", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get profile",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Update user profile
    this.app.put(
      "/profile",
      validator("json", (value, c) => {
        const result = profileUpdateSchema.safeParse(value);
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
          const sessionToken =
            c.req.header("authorization")?.replace("Bearer ", "") ||
            c.req.header("x-session-token");

          if (!sessionToken) {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Session token required",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          const sessionResult = await this.kv.get(["sessions", sessionToken]);
          const session = sessionResult.value as SessionObject | null;

          if (!session || session.expiresAt.getTime() <= Date.now()) {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Invalid or expired session",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          // Get user
          const iter = this.kv.list({ prefix: ["users"] });
          let user: UserObject | null = null;
          let userKey: string | null = null;
          for await (const entry of iter) {
            const u = entry.value as UserObject;
            if (u.id === session.userId) {
              user = u;
              userKey = entry.key[1] as string;
              break;
            }
          }

          if (!user || !userKey) {
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

          // Update user data
          const updatedUser: UserObject = {
            ...user,
            ...(data.displayName && { displayName: data.displayName }),
            ...(data.email !== undefined && { email: data.email }),
            ...(data.avatar && { avatar: data.avatar }),
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

          await this.kv.set(["users", userKey], updatedUser);

          getAuthLogger().info("Profile updated", {
            userId: user.id,
            username: user.username,
          });

          // Return user data without password
          const { hashedPassword: _, ...userResponse } = updatedUser;

          return c.json({
            data: { user: userResponse },
          });
        } catch (error) {
          getAuthLogger().error("Profile update error", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to update profile",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Change password
    this.app.post(
      "/password",
      validator("json", (value, c) => {
        const result = passwordChangeSchema.safeParse(value);
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
          const sessionToken =
            c.req.header("authorization")?.replace("Bearer ", "") ||
            c.req.header("x-session-token");

          if (!sessionToken) {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Session token required",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          const sessionResult = await this.kv.get(["sessions", sessionToken]);
          const session = sessionResult.value as SessionObject | null;

          if (!session || session.expiresAt.getTime() <= Date.now()) {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Invalid or expired session",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          // Get user
          const iter = this.kv.list({ prefix: ["users"] });
          let user: UserObject | null = null;
          let userKey: string | null = null;
          for await (const entry of iter) {
            const u = entry.value as UserObject;
            if (u.id === session.userId) {
              user = u;
              userKey = entry.key[1] as string;
              break;
            }
          }

          if (!user || !userKey || !user.hashedPassword) {
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

          // Verify current password
          const validPassword = await verify(
            user.hashedPassword,
            data.currentPassword,
          );
          if (!validPassword) {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Current password is incorrect",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          // Hash new password
          const hashedPassword = await hash(data.newPassword);

          // Update user
          const updatedUser: UserObject = {
            ...user,
            hashedPassword,
            updatedAt: new Date(),
          };

          await this.kv.set(["users", userKey], updatedUser);

          getAuthLogger().info("Password changed", {
            userId: user.id,
            username: user.username,
          });

          return c.json({
            data: { message: "Password changed successfully" },
          });
        } catch (error) {
          getAuthLogger().error("Password change error", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to change password",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // List user sessions
    this.app.get("/sessions", async (c) => {
      try {
        const sessionToken =
          c.req.header("authorization")?.replace("Bearer ", "") ||
          c.req.header("x-session-token");

        if (!sessionToken) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Session token required",
                timestamp: new Date().toISOString(),
              },
            },
            401,
          );
        }

        const sessionResult = await this.kv.get(["sessions", sessionToken]);
        const currentSession = sessionResult.value as SessionObject | null;

        if (
          !currentSession ||
          currentSession.expiresAt.getTime() <= Date.now()
        ) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Invalid or expired session",
                timestamp: new Date().toISOString(),
              },
            },
            401,
          );
        }

        // Get all user sessions
        const sessions: SessionObject[] = [];
        const iter = this.kv.list({ prefix: ["sessions"] });
        for await (const entry of iter) {
          const session = entry.value as SessionObject;
          if (session.userId === currentSession.userId) {
            sessions.push(session);
          }
        }

        // Sort by creation date
        sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        return c.json({
          data: {
            sessions: sessions.map((s) => ({
              id: s.id,
              userAgent: s.userAgent,
              ipAddress: s.ipAddress,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              expiresAt: s.expiresAt,
              isCurrent: s.id === sessionToken,
            })),
          },
        });
      } catch (error) {
        getAuthLogger().error("Sessions retrieval error", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get sessions",
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
        const sessionToken =
          c.req.header("authorization")?.replace("Bearer ", "") ||
          c.req.header("x-session-token");

        if (!sessionToken) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Session token required",
                timestamp: new Date().toISOString(),
              },
            },
            401,
          );
        }

        const currentSessionResult = await this.kv.get([
          "sessions",
          sessionToken,
        ]);
        const currentSession =
          currentSessionResult.value as SessionObject | null;

        if (
          !currentSession ||
          currentSession.expiresAt.getTime() <= Date.now()
        ) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Invalid or expired session",
                timestamp: new Date().toISOString(),
              },
            },
            401,
          );
        }

        // Get target session
        const targetSessionResult = await this.kv.get(["sessions", sessionId]);
        const targetSession = targetSessionResult.value as SessionObject | null;

        if (!targetSession) {
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

        // Check if user owns the session
        if (targetSession.userId !== currentSession.userId) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Cannot revoke another user's session",
                timestamp: new Date().toISOString(),
              },
            },
            403,
          );
        }

        // Delete session
        await this.kv.delete(["sessions", sessionId]);

        getAuthLogger().info("Session revoked", {
          sessionId,
          userId: currentSession.userId,
        });

        return c.json({
          data: { message: "Session revoked successfully" },
        });
      } catch (error) {
        getAuthLogger().error("Session revocation error", {
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
  }

  getApp(): Hono {
    return this.app;
  }
}

export function createAuthRoutes(kv: Deno.Kv, authService: AuthService): Hono {
  const authRoutes = new AuthRoutes(kv, authService);
  return authRoutes.getApp();
}
