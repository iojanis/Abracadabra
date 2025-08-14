// Authentication Service for Abracadabra Server
// Handles user registration, login, session management using Lucia Auth v3

import { hash, verify, validatePasswordStrength } from "./utils/password.ts";
import { ERROR_CODES } from "./types/index.ts";
import type {
  UserObject,
  UserSettings,
  SessionObject,
  PermissionLevel,
  UserKey,
  UsernameIndexKey,
  EmailIndexKey,
  SessionKey,
} from "./types/index.ts";
import { getLogger } from "./services/logging.ts";
import type { ConfigService } from "./services/config.ts";
import type { PermissionService } from "./services/permissions.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getAuthLogger() {
  if (!logger) {
    logger = getLogger(["auth"]);
  }
  return logger;
}

export interface AuthResult {
  success: boolean;
  user?: UserObject;
  session?: SessionObject;
  error?: {
    code: string;
    message: string;
  };
}

export interface RegisterData {
  username: string;
  email?: string;
  displayName: string;
  password: string;
}

export interface LoginData {
  identifier: string; // Can be username or email
  password: string;
}

export class AuthService {
  private kv: Deno.Kv;
  private config: ConfigService;
  private permissionService: PermissionService;

  constructor(
    kv: Deno.Kv,
    config: ConfigService,
    permissionService: PermissionService,
  ) {
    this.kv = kv;
    this.config = config;
    this.permissionService = permissionService;
  }

  /**
   * Register a new user
   */
  async register(data: RegisterData): Promise<AuthResult> {
    try {
      // Validate input
      const validation = this.validateRegistrationData(data);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_INPUT,
            message: validation.error!,
          },
        };
      }

      // Check if username already exists
      const existingByUsername = await this.getUserByUsername(data.username);
      if (existingByUsername) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            message: "Username already exists",
          },
        };
      }

      // Check if email already exists (if provided)
      if (data.email) {
        const existingByEmail = await this.getUserByEmail(data.email);
        if (existingByEmail) {
          return {
            success: false,
            error: {
              code: ERROR_CODES.DUPLICATE_RESOURCE,
              message: "Email already exists",
            },
          };
        }
      }

      // Hash password
      const hashedPassword = await hash(data.password);

      // Create user object
      const now = new Date();
      const userId = crypto.randomUUID();

      const defaultSettings: UserSettings = {
        defaultPermissions: "VIEWER",
        emailNotifications: true,
        maxNestingDepth:
          (await this.config.get<number>("documents.max_nesting_depth")) ?? 10,
      };

      const user: UserObject = {
        id: userId,
        username: data.username,
        ...(data.email && { email: data.email }),
        displayName: data.displayName,
        hashedPassword,
        createdAt: now,
        updatedAt: now,
        isActive: true,
        settings: defaultSettings,
      };

      // Store user and create indexes atomically
      const userKey: UserKey = ["users", "by_id", userId];
      const usernameIndexKey: UsernameIndexKey = [
        "users",
        "by_username",
        data.username,
      ];
      const emailIndexKey: EmailIndexKey | null = data.email
        ? ["users", "by_email", data.email]
        : null;

      const atomic = this.kv.atomic();
      atomic.set(userKey, user);
      atomic.set(usernameIndexKey, userId);
      if (emailIndexKey) {
        atomic.set(emailIndexKey, userId);
      }

      const result = await atomic.commit();
      if (!result.ok) {
        getAuthLogger().error(
          "Failed to create user - atomic transaction failed",
          {
            username: data.username,
          },
        );
        return {
          success: false,
          error: {
            code: ERROR_CODES.INTERNAL_SERVER_ERROR,
            message: "Failed to create user",
          },
        };
      }

      // Bootstrap user permissions - grant OWNER permission to their namespace
      try {
        await this.bootstrapUserPermissions(userId, data.username);
      } catch (error) {
        getAuthLogger().warn("Failed to bootstrap user permissions", {
          userId,
          username: data.username,
          error: (error as Error).message,
        });
        // Continue anyway - permissions can be set later
      }

      // Create session
      const sessionResult = await this.createSession(userId);
      if (!sessionResult.success) {
        return sessionResult;
      }

      getAuthLogger().info("User registered successfully", {
        userId,
        username: data.username,
      });

      return {
        success: true,
        user: this.sanitizeUser(user),
        session: sessionResult.session!,
      };
    } catch (error) {
      getAuthLogger().error("Registration error", {
        error: (error as Error).message,
        username: data.username,
      });
      return {
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_SERVER_ERROR,
          message: "Registration failed",
        },
      };
    }
  }

  /**
   * Login user
   */
  async login(data: LoginData): Promise<AuthResult> {
    try {
      // Find user by username or email
      const user = await this.getUserByIdentifier(data.identifier);
      if (!user) {
        // Don't reveal whether username/email exists
        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Invalid credentials",
          },
        };
      }

      if (!user.isActive) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Account is disabled",
          },
        };
      }

      // Verify password
      if (!user.hashedPassword) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Invalid credentials",
          },
        };
      }

      const isValid = await verify(user.hashedPassword, data.password);
      if (!isValid) {
        getAuthLogger().warn("Failed login attempt", {
          userId: user.id,
          username: user.username,
          identifier: data.identifier,
        });

        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Invalid credentials",
          },
        };
      }

      // Create session
      const sessionResult = await this.createSession(user.id);
      if (!sessionResult.success) {
        return sessionResult;
      }

      getAuthLogger().info("User registered successfully", {
        userId: user.id,
        username: user.username,
      });

      return {
        success: true,
        user: this.sanitizeUser(user),
        session: sessionResult.session!,
      };
    } catch (error) {
      getAuthLogger().error("Login error", {
        error: (error as Error).message,
        identifier: data.identifier,
      });
      return {
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_SERVER_ERROR,
          message: "Login failed",
        },
      };
    }
  }

  /**
   * Validate session token
   */
  async validateSession(sessionId: string): Promise<AuthResult> {
    try {
      const sessionKey: SessionKey = ["sessions", sessionId];
      const sessionResult = await this.kv.get(sessionKey);

      if (!sessionResult.value) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Invalid session",
          },
        };
      }

      const session = sessionResult.value as SessionObject;

      // Check if session is expired
      if (session.expiresAt < new Date()) {
        await this.deleteSession(sessionId);
        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Session expired",
          },
        };
      }

      // Get user
      const user = await this.getUserById(session.userId);
      if (!user || !user.isActive) {
        await this.deleteSession(sessionId);
        return {
          success: false,
          error: {
            code: ERROR_CODES.AUTHENTICATION_REQUIRED,
            message: "Invalid session",
          },
        };
      }

      return {
        success: true,
        user: this.sanitizeUser(user),
        session,
      };
    } catch (error) {
      getAuthLogger().error("Session validation error", {
        error: (error as Error).message,
        sessionId,
      });
      return {
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_SERVER_ERROR,
          message: "Session validation failed",
        },
      };
    }
  }

  /**
   * Logout user (delete session)
   */
  async logout(sessionId: string): Promise<{ success: boolean }> {
    try {
      await this.deleteSession(sessionId);
      getAuthLogger().info("User logged out", { sessionId });
      return { success: true };
    } catch (error) {
      getAuthLogger().error("Logout error", {
        error: (error as Error).message,
        sessionId,
      });
      return { success: false };
    }
  }

  /**
   * Update user profile
   */
  async updateUser(
    userId: string,
    updates: Partial<Pick<UserObject, "displayName" | "email" | "settings">>,
  ): Promise<AuthResult> {
    try {
      const user = await this.getUserById(userId);
      if (!user) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.USER_NOT_FOUND,
            message: "User not found",
          },
        };
      }

      // Check for email conflicts if email is being updated
      if (updates.email && updates.email !== user.email) {
        const existingUser = await this.getUserByEmail(updates.email);
        if (existingUser && existingUser.id !== userId) {
          return {
            success: false,
            error: {
              code: ERROR_CODES.DUPLICATE_RESOURCE,
              message: "Email already exists",
            },
          };
        }
      }

      // Update user
      const updatedUser: UserObject = {
        ...user,
        ...updates,
        updatedAt: new Date(),
      };

      const userKey: UserKey = ["users", "by_id", userId];
      const atomic = this.kv.atomic();
      atomic.set(userKey, updatedUser);

      // Update email index if email changed
      if (updates.email && updates.email !== user.email) {
        // Remove old email index
        if (user.email) {
          const oldEmailKey: EmailIndexKey = ["users", "by_email", user.email];
          atomic.delete(oldEmailKey);
        }
        // Add new email index
        const newEmailKey: EmailIndexKey = ["users", "by_email", updates.email];
        atomic.set(newEmailKey, userId);
      }

      const result = await atomic.commit();
      if (!result.ok) {
        return {
          success: false,
          error: {
            code: ERROR_CODES.INTERNAL_SERVER_ERROR,
            message: "Failed to update user",
          },
        };
      }

      getAuthLogger().info("User updated successfully", { userId });

      return {
        success: true,
        user: this.sanitizeUser(updatedUser),
      };
    } catch (error) {
      getAuthLogger().error("User update error", {
        error: (error as Error).message,
        userId,
      });
      return {
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_SERVER_ERROR,
          message: "Failed to update user",
        },
      };
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async createSession(userId: string): Promise<AuthResult> {
    try {
      const sessionTimeout =
        (await this.config.get<number>("authentication.session_timeout")) ??
        2592000; // 30 days

      const now = new Date();
      const session: SessionObject = {
        id: crypto.randomUUID(),
        userId,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + sessionTimeout * 1000),
      };

      const sessionKey: SessionKey = ["sessions", session.id];
      await this.kv.set(sessionKey, session);

      return {
        success: true,
        session,
      };
    } catch (error) {
      getAuthLogger().error("Session creation error", {
        error: (error as Error).message,
        userId,
      });
      return {
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_SERVER_ERROR,
          message: "Failed to create session",
        },
      };
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const sessionKey: SessionKey = ["sessions", sessionId];
    await this.kv.delete(sessionKey);
  }

  private async getUserById(userId: string): Promise<UserObject | null> {
    const userKey: UserKey = ["users", "by_id", userId];
    const result = await this.kv.get(userKey);
    return result.value as UserObject | null;
  }

  private async getUserByUsername(
    username: string,
  ): Promise<UserObject | null> {
    const indexKey: UsernameIndexKey = ["users", "by_username", username];
    const indexResult = await this.kv.get(indexKey);

    if (!indexResult.value) return null;

    return await this.getUserById(indexResult.value as string);
  }

  private async getUserByEmail(email: string): Promise<UserObject | null> {
    const indexKey: EmailIndexKey = ["users", "by_email", email];
    const indexResult = await this.kv.get(indexKey);

    if (!indexResult.value) return null;

    return await this.getUserById(indexResult.value as string);
  }

  private async getUserByIdentifier(
    identifier: string,
  ): Promise<UserObject | null> {
    // Try username first
    let user = await this.getUserByUsername(identifier);
    if (user) return user;

    // Try email if identifier looks like an email
    if (identifier.includes("@")) {
      user = await this.getUserByEmail(identifier);
    }

    return user;
  }

  private sanitizeUser(user: UserObject): UserObject {
    // Remove sensitive information
    const { hashedPassword, ...sanitized } = user;
    return sanitized as UserObject;
  }

  /**
   * Bootstrap user permissions by granting OWNER permission to their namespace
   */
  private async bootstrapUserPermissions(
    userId: string,
    username: string,
  ): Promise<void> {
    const userPath = `/${username}`;

    getAuthLogger().debug("Bootstrapping user permissions", {
      userId,
      username,
      path: userPath,
    });

    // Create default permissions for the user's namespace
    // This gives them OWNER permission to create/manage documents in their own space
    const permissions = {
      owner: userId,
      admins: [],
      editors: [],
      commenters: [],
      viewers: [],
      publicAccess: "NONE" as const,
      inherit: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Store the permission directly in KV since we're bootstrapping
    await this.kv.set(["documents", "permissions", userPath], permissions);

    getAuthLogger().info("User permissions bootstrapped", {
      userId,
      username,
      path: userPath,
    });
  }

  private validateRegistrationData(data: RegisterData): {
    valid: boolean;
    error?: string;
  } {
    // Username validation
    if (!data.username || data.username.length < 3) {
      return {
        valid: false,
        error: "Username must be at least 3 characters long",
      };
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(data.username)) {
      return {
        valid: false,
        error:
          "Username can only contain letters, numbers, hyphens, and underscores",
      };
    }

    // Display name validation
    if (!data.displayName || data.displayName.trim().length === 0) {
      return { valid: false, error: "Display name is required" };
    }

    if (data.displayName.length > 100) {
      return {
        valid: false,
        error: "Display name must be less than 100 characters",
      };
    }

    // Email validation (if provided)
    if (data.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email)) {
        return { valid: false, error: "Invalid email format" };
      }
    }

    // Password validation
    const passwordValidation = validatePasswordStrength(data.password);
    if (!passwordValidation.valid) {
      return {
        valid: false,
        error: passwordValidation.errors[0], // Return first error
      };
    }

    return { valid: true };
  }
}

// Singleton instance
let authService: AuthService | null = null;

/**
 * Get the global auth service instance
 */
export function getAuthService(): AuthService {
  if (!authService) {
    throw new Error(
      "Auth service not initialized. Call createAuthService() first.",
    );
  }
  return authService;
}

/**
 * Create and initialize the global auth service
 */
export async function createAuthService(
  kv: Deno.Kv,
  config: ConfigService,
  permissionService: PermissionService,
): Promise<AuthService> {
  if (authService) {
    return authService;
  }

  authService = new AuthService(kv, config, permissionService);
  getAuthLogger().info("Auth service initialized");
  return authService;
}

/**
 * Utility function for token-based authentication (for testing/simple cases)
 * Format: userid__PERMISSION_LEVEL
 */
export function parseTestToken(
  token: string,
): { userId: string; role: string } | null {
  const parts = token.split("__");
  if (parts.length !== 2) return null;

  const role = parts[1];
  if (!["COMMENT-ONLY", "READ-WRITE", "ADMIN"].includes(role)) return null;

  return {
    userId: parts[0],
    role,
  };
}
