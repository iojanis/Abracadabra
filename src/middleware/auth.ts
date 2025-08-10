// Authentication Middleware for Abracadabra Server
// Provides route-level authentication and authorization protection

import type { Context, Next } from "hono";
import type { SessionContext } from "./session.ts";
import { getLogger } from "../services/logging.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getAuthMiddlewareLogger() {
  if (!logger) {
    logger = getLogger(["middleware", "auth"]);
  }
  return logger;
}

export interface AuthConfig {
  requireAuth?: boolean;
  requireActive?: boolean;
  redirectUrl?: string;
}

export interface AuthContext {
  isAuthenticated: boolean;
  userId?: string;
  username?: string;
  user?: any;
}

/**
 * Authentication middleware that requires valid authentication
 */
export function requireAuth(config: AuthConfig = {}) {
  return async (c: Context, next: Next) => {
    const { requireAuth = true, requireActive = true, redirectUrl } = config;

    try {
      const sessionContext = c.get("sessionContext") as SessionContext;

      // Check if user is authenticated
      if (requireAuth && !sessionContext?.isAuthenticated) {
        getAuthMiddlewareLogger().warn("Authentication required", {
          path: c.req.path,
          method: c.req.method,
        });

        if (redirectUrl) {
          return c.redirect(redirectUrl);
        }

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

      // Check if user account is active
      if (
        requireActive &&
        sessionContext?.user &&
        !sessionContext.user.isActive
      ) {
        getAuthMiddlewareLogger().warn("Inactive user attempted access", {
          userId: sessionContext.userId,
          username: sessionContext.username,
          path: c.req.path,
        });

        return c.json(
          {
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "Account is disabled",
              timestamp: new Date().toISOString(),
            },
          },
          401,
        );
      }

      // Set auth context for downstream handlers
      if (sessionContext?.isAuthenticated) {
        c.set("userId", sessionContext.userId);
        c.set("username", sessionContext.username);
        c.set("user", sessionContext.user);
        c.set("isAuthenticated", true);
      } else {
        c.set("isAuthenticated", false);
      }

      return await next();
    } catch (error) {
      getAuthMiddlewareLogger().error("Authentication middleware error", {
        path: c.req.path,
        method: c.req.method,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      return c.json(
        {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Authentication check failed",
            timestamp: new Date().toISOString(),
          },
        },
        500,
      );
    }
  };
}

/**
 * Optional authentication middleware that allows both authenticated and anonymous access
 */
export function optionalAuth() {
  return async (c: Context, next: Next) => {
    try {
      const sessionContext = c.get("sessionContext") as SessionContext;

      // Set auth context regardless of authentication status
      if (sessionContext?.isAuthenticated && sessionContext.user?.isActive) {
        c.set("userId", sessionContext.userId);
        c.set("username", sessionContext.username);
        c.set("user", sessionContext.user);
        c.set("isAuthenticated", true);
      } else {
        c.set("isAuthenticated", false);
      }

      return await next();
    } catch (error) {
      getAuthMiddlewareLogger().error("Optional auth middleware error", {
        path: c.req.path,
        method: c.req.method,
        error: (error as Error).message,
      });

      // Don't fail the request for optional auth errors
      c.set("isAuthenticated", false);
      return await next();
    }
  };
}

/**
 * Admin-only middleware that requires admin privileges
 */
export function requireAdmin() {
  return async (c: Context, next: Next) => {
    try {
      const sessionContext = c.get("sessionContext") as SessionContext;

      // Check authentication first
      if (!sessionContext?.isAuthenticated) {
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

      // Check if user is active
      if (!sessionContext.user?.isActive) {
        return c.json(
          {
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "Account is disabled",
              timestamp: new Date().toISOString(),
            },
          },
          401,
        );
      }

      // For now, we'll check if user has admin-level default permissions
      // In a real system, you'd have a more sophisticated role system
      const isAdmin =
        sessionContext.user?.settings?.defaultPermissions === "ADMIN" ||
        sessionContext.user?.settings?.defaultPermissions === "OWNER";

      if (!isAdmin) {
        getAuthMiddlewareLogger().warn(
          "Non-admin user attempted admin access",
          {
            userId: sessionContext.userId,
            username: sessionContext.username,
            path: c.req.path,
          },
        );

        return c.json(
          {
            error: {
              code: "PERMISSION_DENIED",
              message: "Administrator privileges required",
              timestamp: new Date().toISOString(),
            },
          },
          403,
        );
      }

      // Set context
      c.set("userId", sessionContext.userId);
      c.set("username", sessionContext.username);
      c.set("user", sessionContext.user);
      c.set("isAuthenticated", true);
      c.set("isAdmin", true);

      return await next();
    } catch (error) {
      getAuthMiddlewareLogger().error("Admin middleware error", {
        path: c.req.path,
        method: c.req.method,
        error: (error as Error).message,
      });

      return c.json(
        {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Authorization check failed",
            timestamp: new Date().toISOString(),
          },
        },
        500,
      );
    }
  };
}

/**
 * Middleware to ensure user can only access their own resources
 */
export function requireSelfOrAdmin(
  getUserIdFromPath: (path: string) => string | null,
) {
  return async (c: Context, next: Next) => {
    try {
      const sessionContext = c.get("sessionContext") as SessionContext;

      // Check authentication first
      if (!sessionContext?.isAuthenticated) {
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

      const currentUserId = sessionContext.userId;
      const targetUserId = getUserIdFromPath(c.req.path);

      // Check if user is admin
      const isAdmin =
        sessionContext.user?.settings?.defaultPermissions === "ADMIN" ||
        sessionContext.user?.settings?.defaultPermissions === "OWNER";

      // Allow if admin or accessing own resources
      if (!isAdmin && currentUserId !== targetUserId) {
        getAuthMiddlewareLogger().warn(
          "User attempted to access another user's resource",
          {
            currentUserId,
            targetUserId,
            path: c.req.path,
          },
        );

        return c.json(
          {
            error: {
              code: "PERMISSION_DENIED",
              message: "Can only access your own resources",
              timestamp: new Date().toISOString(),
            },
          },
          403,
        );
      }

      // Set context
      c.set("userId", sessionContext.userId);
      c.set("username", sessionContext.username);
      c.set("user", sessionContext.user);
      c.set("isAuthenticated", true);
      c.set("isAdmin", isAdmin);

      return await next();
    } catch (error) {
      getAuthMiddlewareLogger().error("Self-or-admin middleware error", {
        path: c.req.path,
        method: c.req.method,
        error: (error as Error).message,
      });

      return c.json(
        {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Authorization check failed",
            timestamp: new Date().toISOString(),
          },
        },
        500,
      );
    }
  };
}

/**
 * Rate limiting middleware (simple implementation)
 */
export function rateLimit(options: {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: Context) => string;
}) {
  const requests = new Map<string, { count: number; resetTime: number }>();

  return async (c: Context, next: Next) => {
    try {
      const key = options.keyGenerator
        ? options.keyGenerator(c)
        : c.req.header("x-forwarded-for") || "unknown";

      const now = Date.now();
      const windowStart = now - options.windowMs;

      // Clean up old entries
      for (const [k, v] of requests.entries()) {
        if (v.resetTime <= now) {
          requests.delete(k);
        }
      }

      // Get or create request record
      let record = requests.get(key);
      if (!record || record.resetTime <= now) {
        record = {
          count: 0,
          resetTime: now + options.windowMs,
        };
        requests.set(key, record);
      }

      // Check rate limit
      if (record.count >= options.maxRequests) {
        getAuthMiddlewareLogger().warn("Rate limit exceeded", {
          key: key.substring(0, 8),
          count: record.count,
          limit: options.maxRequests,
          path: c.req.path,
        });

        return c.json(
          {
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message: "Too many requests",
              timestamp: new Date().toISOString(),
            },
          },
          429,
        );
      }

      // Increment count
      record.count++;

      // Set rate limit headers
      c.header("X-RateLimit-Limit", options.maxRequests.toString());
      c.header(
        "X-RateLimit-Remaining",
        Math.max(0, options.maxRequests - record.count).toString(),
      );
      c.header("X-RateLimit-Reset", new Date(record.resetTime).toISOString());

      return await next();
    } catch (error) {
      getAuthMiddlewareLogger().error("Rate limiting error", {
        error: (error as Error).message,
      });

      // Don't fail the request due to rate limiting errors
      return await next();
    }
  };
}

/**
 * CORS middleware for API routes
 */
export function apiCors(
  options: {
    allowedOrigins?: string[];
    allowedMethods?: string[];
    allowedHeaders?: string[];
    maxAge?: number;
  } = {},
) {
  const {
    allowedOrigins = ["*"],
    allowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders = ["Content-Type", "Authorization", "X-Session-Token"],
    maxAge = 86400,
  } = options;

  return async (c: Context, next: Next) => {
    const origin = c.req.header("origin");

    // Set CORS headers
    if (
      allowedOrigins.includes("*") ||
      (origin && allowedOrigins.includes(origin))
    ) {
      c.header("Access-Control-Allow-Origin", origin || "*");
    }

    c.header("Access-Control-Allow-Methods", allowedMethods.join(", "));
    c.header("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    c.header("Access-Control-Max-Age", maxAge.toString());
    c.header("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (c.req.method === "OPTIONS") {
      return new Response("", { status: 204 });
    }

    return await next();
  };
}

/**
 * Utility function to check if request is authenticated
 */
export function isAuthenticated(c: Context): boolean {
  return c.get("isAuthenticated") === true;
}

/**
 * Utility function to get current user ID
 */
export function getCurrentUserId(c: Context): string | undefined {
  return c.get("userId");
}

/**
 * Utility function to get current username
 */
export function getCurrentUsername(c: Context): string | undefined {
  return c.get("username");
}

/**
 * Utility function to get current user object
 */
export function getCurrentUser(c: Context): any | undefined {
  return c.get("user");
}

/**
 * Utility function to check if current user is admin
 */
export function isAdmin(c: Context): boolean {
  return c.get("isAdmin") === true;
}
