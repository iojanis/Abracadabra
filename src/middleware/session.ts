// Session Middleware for Abracadabra Server
// Handles session validation, authentication state, and user context

import type { Context, Next } from "hono";
import type { UserObject, SessionObject } from "../types/index.ts";
import { getLogger } from "../services/logging.ts";
import { getCookie } from "hono/cookie";

export interface SessionContext {
  user: UserObject | null;
  session: SessionObject | null;
  isAuthenticated: boolean;
  userId?: string;
  username?: string;
}

let logger: ReturnType<typeof getLogger> | null = null;

function getSessionLogger() {
  if (!logger) {
    logger = getLogger(["middleware", "session"]);
  }
  return logger;
}

export interface SessionMiddlewareConfig {
  cookieName?: string;
  headerName?: string;
  sessionTimeout?: number;
  requireAuth?: boolean;
  skipPaths?: string[];
}

export class SessionMiddleware {
  private kv: Deno.Kv;
  private config: SessionMiddlewareConfig;

  constructor(kv: Deno.Kv, config: SessionMiddlewareConfig = {}) {
    this.kv = kv;
    this.config = {
      cookieName: "abracadabra_session",
      headerName: "Authorization",
      sessionTimeout: 2592000000, // 30 days in milliseconds
      requireAuth: false,
      skipPaths: ["/health", "/docs", "/api/auth/login", "/api/auth/register"],
      ...config,
    };
  }

  /**
   * Main middleware function
   */
  handle() {
    return async (c: Context, next: Next): Promise<Response | void> => {
      const path = c.req.path;
      const method = c.req.method;

      // Skip authentication for certain paths
      if (this.shouldSkipAuth(path, method)) {
        c.set("session", this.createEmptySession());
        await next();
        return;
      }

      try {
        // Extract session token from request
        const token = this.extractToken(c);

        getSessionLogger().debug("Session middleware processing request", {
          path,
          method,
          hasToken: !!token,
          requireAuth: this.config.requireAuth,
        });

        if (!token) {
          if (this.config.requireAuth) {
            getSessionLogger().warn(
              "No session token provided for protected route",
              {
                path,
                method,
              },
            );
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Authentication required",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          c.set("session", this.createEmptySession());
          await next();
          return;
        }

        // Validate session
        const sessionContext = await this.validateSession(token);

        getSessionLogger().debug("Session validation result", {
          isAuthenticated: sessionContext.isAuthenticated,
          hasUser: !!sessionContext.user,
          hasSession: !!sessionContext.session,
        });

        if (!sessionContext.isAuthenticated) {
          if (this.config.requireAuth) {
            getSessionLogger().warn(
              "Invalid session token for protected route",
              {
                path,
                method,
                token: token.substring(0, 8),
              },
            );
            return c.json(
              {
                error: {
                  code: "UNAUTHORIZED",
                  message: "Invalid or expired session",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }

          c.set("session", this.createEmptySession());
          await next();
          return;
        }

        // Set session context
        c.set("session", sessionContext);

        getSessionLogger().debug("Session context set successfully", {
          userId: sessionContext.user?.id,
          username: sessionContext.user?.username,
        });

        // Update session activity
        if (sessionContext.session) {
          await this.updateSessionActivity(sessionContext.session.id);
        }

        getSessionLogger().debug("Session validated successfully", {
          userId: sessionContext.userId,
          username: sessionContext.username,
          path,
          method,
        });

        await next();
      } catch (error) {
        getSessionLogger().error("Session middleware error", {
          path,
          method,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });

        if (this.config.requireAuth) {
          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Session validation failed",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }

        // Continue with empty session if auth not required
        c.set("session", this.createEmptySession());
        await next();
      }
    };
  }

  /**
   * Extract session token from request
   */
  private extractToken(c: Context): string | null {
    // Try cookie first
    const cookieToken = getCookie(c, this.config.cookieName!);
    if (cookieToken) {
      getSessionLogger().debug("Token found in cookie", {
        cookieName: this.config.cookieName,
        tokenStart: cookieToken.substring(0, 8),
      });
      return cookieToken;
    }

    // Try Authorization header
    const authHeader = c.req.header(this.config.headerName!);
    getSessionLogger().debug("Checking Authorization header", {
      headerName: this.config.headerName,
      authHeader: authHeader ? `${authHeader.substring(0, 20)}...` : null,
    });

    if (authHeader) {
      // Support both "Bearer token" and plain token formats
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        getSessionLogger().debug("Bearer token extracted", {
          tokenStart: token.substring(0, 8),
        });
        return token;
      }
      getSessionLogger().debug("Plain token extracted", {
        tokenStart: authHeader.substring(0, 8),
      });
      return authHeader;
    }

    getSessionLogger().debug("No token found", {
      cookieName: this.config.cookieName,
      headerName: this.config.headerName,
    });
    return null;
  }

  /**
   * Validate session token and return session context
   */
  private async validateSession(token: string): Promise<SessionContext> {
    try {
      getSessionLogger().debug("Validating session", {
        token: token.substring(0, 8),
        sessionKey: ["sessions", token.substring(0, 8) + "..."],
      });

      // Get session from KV
      const sessionResult = await this.kv.get(["sessions", token]);
      const session = sessionResult.value as SessionObject | null;

      if (!session) {
        getSessionLogger().debug("Session not found in KV", {
          token: token.substring(0, 8),
          sessionKey: ["sessions", token],
        });
        return this.createEmptySession();
      }

      getSessionLogger().debug("Session found in KV", {
        sessionId: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
      });

      // Check if session is expired
      const now = Date.now();
      if (session.expiresAt.getTime() <= now) {
        getSessionLogger().warn("Session expired", {
          sessionId: session.id,
          expiresAt: session.expiresAt.getTime(),
          now,
        });

        // Clean up expired session
        await this.kv.delete(["sessions", token]);
        return this.createEmptySession();
      }

      // Get user data
      const userKey = ["users", "by_id", session.userId];
      getSessionLogger().debug("Looking up user", {
        userKey,
        userId: session.userId,
      });

      const userResult = await this.kv.get(userKey);
      const user = userResult.value as UserObject | null;

      if (!user) {
        getSessionLogger().warn("User not found for valid session", {
          sessionId: session.id,
          userId: session.userId,
          userKey,
        });

        // Clean up orphaned session
        await this.kv.delete(["sessions", token]);
        return this.createEmptySession();
      }

      getSessionLogger().debug("User found for session", {
        userId: user.id,
        username: user.username,
        isActive: user.isActive,
      });

      // Check if user account is active
      if (!user.isActive) {
        getSessionLogger().warn("Session found for inactive user", {
          sessionId: session.id,
          userId: session.userId,
          username: user.username,
        });
        return this.createEmptySession();
      }

      return {
        user,
        session,
        isAuthenticated: true,
        userId: user.id,
        username: user.username,
      };
    } catch (error) {
      getSessionLogger().error("Error validating session", {
        token: token.substring(0, 8),
        error: (error as Error).message,
      });
      return this.createEmptySession();
    }
  }

  /**
   * Update session last activity timestamp
   */
  private async updateSessionActivity(sessionId: string): Promise<void> {
    try {
      const sessionResult = await this.kv.get(["sessions", sessionId]);
      const session = sessionResult.value as SessionObject | null;

      if (session) {
        const updatedSession: SessionObject = {
          ...session,
          updatedAt: new Date(),
        };

        await this.kv.set(["sessions", sessionId], updatedSession);
      }
    } catch (error) {
      getSessionLogger().error("Failed to update session activity", {
        sessionId,
        error: (error as Error).message,
      });
      // Don't throw - this is not critical
    }
  }

  /**
   * Check if authentication should be skipped for this path
   */
  private shouldSkipAuth(path: string, method: string): boolean {
    // Skip auth for specific paths
    if (this.config.skipPaths?.includes(path)) {
      return true;
    }

    // Skip auth for paths that start with skip patterns
    const skipPatterns = ["/api/auth/", "/health", "/docs"];
    return skipPatterns.some((pattern) => path.startsWith(pattern));
  }

  /**
   * Create empty session context
   */
  private createEmptySession(): SessionContext {
    return {
      user: null,
      session: null,
      isAuthenticated: false,
    };
  }

  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    getSessionLogger().info("Starting session cleanup");

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
          batchSize++;
          cleaned++;

          // Commit batch if it gets too large
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
      getSessionLogger().error("Error during session cleanup", {
        error: (error as Error).message,
        cleaned,
      });
    }

    getSessionLogger().info("Session cleanup completed", { cleaned });
    return cleaned;
  }
}

/**
 * Create session middleware with standard configuration
 */
export function createSessionMiddleware(
  kv: Deno.Kv,
  config?: SessionMiddlewareConfig,
) {
  const middleware = new SessionMiddleware(kv, config);
  return middleware.handle();
}

/**
 * Create session middleware that requires authentication
 */
export function createAuthRequiredMiddleware(
  kv: Deno.Kv,
  config?: Omit<SessionMiddlewareConfig, "requireAuth">,
) {
  const middleware = new SessionMiddleware(kv, {
    ...config,
    requireAuth: true,
  });
  return middleware.handle();
}

/**
 * Helper function to get session context from Hono context
 */
export function getSessionContext(c: Context): SessionContext {
  return (
    c.get("session") || {
      user: null,
      session: null,
      isAuthenticated: false,
    }
  );
}

/**
 * Helper function to get authenticated user from context
 */
export function getAuthenticatedUser(c: Context): UserObject | null {
  const session = getSessionContext(c);
  return session.isAuthenticated ? session.user : null;
}

/**
 * Helper function to require authentication
 */
export function requireAuth(c: Context): UserObject {
  const user = getAuthenticatedUser(c);
  if (!user) {
    throw new Error("Authentication required");
  }
  return user;
}
