// Permission Service for Abracadabra Server
// Handles hierarchical permission inheritance and CASL-based authorization

import { createMongoAbility, type MongoAbility } from "@casl/ability";
import type {
  DocumentMetadataObject,
  DocumentPermissions,
  PermissionLevel,
  PermissionObject,
  ServerConfig,
  UserObject,
} from "../types/index.ts";
import type { ConfigService } from "./config.ts";
import { getLogger } from "./logging.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getPermissionLogger() {
  if (!logger) {
    logger = getLogger(["permissions"]);
  }
  return logger;
}

export type Action =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "comment"
  | "collaborate"
  | "share"
  | "admin";

export type Subject = "Document" | "User" | "Config" | "System" | "all";

export type AppAbility = MongoAbility<[Action, Subject]>;

export interface PermissionContext {
  userId: string;
  username: string;
  isAdmin?: boolean;
  documentPath?: string;
}

export interface ResolvedPermission {
  level: PermissionLevel;
  inherited: boolean;
  inheritedFrom?: string;
  explicit: boolean;
  publicAccess: boolean;
}

export class PermissionService {
  private kv: Deno.Kv;
  private config: ServerConfig;

  constructor(kv: Deno.Kv, configService: ConfigService) {
    this.kv = kv;
    // Initialize with defaults, will be updated asynchronously
    this.config = {
      max_nesting_depth: 10,
      enable_public_documents: true,
    } as ServerConfig;

    // Load config asynchronously
    this.initializeConfig(configService);
  }

  private async initializeConfig(configService: ConfigService) {
    try {
      this.config = (await configService.getServerConfig()) as ServerConfig;
    } catch (error) {
      getPermissionLogger().error(
        "Failed to load configuration, using defaults",
        { error },
      );
    }
  }

  // ============================================================================
  // Permission Level Utilities
  // ============================================================================

  /**
   * Convert permission level to numeric value for comparison
   */
  private getPermissionValue(level: PermissionLevel): number {
    switch (level) {
      case "NONE":
        return 0;
      case "VIEWER":
        return 1;
      case "COMMENTER":
        return 2;
      case "EDITOR":
        return 3;
      case "ADMIN":
        return 4;
      case "OWNER":
        return 5;
      default:
        return 0;
    }
  }

  /**
   * Compare two permission levels
   */
  hasPermissionLevel(
    userLevel: PermissionLevel,
    requiredLevel: PermissionLevel,
  ): boolean {
    return (
      this.getPermissionValue(userLevel) >=
        this.getPermissionValue(requiredLevel)
    );
  }

  /**
   * Get the higher of two permission levels
   */
  getHigherPermission(
    level1: PermissionLevel,
    level2: PermissionLevel,
  ): PermissionLevel {
    return this.getPermissionValue(level1) >= this.getPermissionValue(level2) ? level1 : level2;
  }

  // ============================================================================
  // Permission Resolution
  // ============================================================================

  /**
   * Resolve permission for a user on a specific document path
   * Implements hierarchical permission inheritance
   */
  async resolvePermission(
    userId: string,
    documentPath: string,
  ): Promise<ResolvedPermission> {
    getPermissionLogger().debug("Resolving permission", {
      userId,
      documentPath,
    });

    // Normalize path
    const normalizedPath = this.normalizePath(documentPath);

    // Check direct permissions on this document
    const directPermission = await this.getDirectPermission(
      userId,
      normalizedPath,
    );
    if (directPermission.level !== "NONE") {
      getPermissionLogger().debug("Found direct permission", {
        userId,
        documentPath: normalizedPath,
        level: directPermission.level,
      });
      return {
        level: directPermission.level,
        inherited: false,
        explicit: true,
        publicAccess: directPermission.publicAccess,
      };
    }

    // Check inherited permissions from parent documents
    const inheritedPermission = await this.getInheritedPermission(
      userId,
      normalizedPath,
    );
    if (inheritedPermission.level !== "NONE") {
      getPermissionLogger().debug("Found inherited permission", {
        userId,
        documentPath: normalizedPath,
        level: inheritedPermission.level,
        inheritedFrom: inheritedPermission.inheritedFrom,
      });
      return inheritedPermission;
    }

    // Check public access
    const publicPermission = await this.getPublicPermission(normalizedPath);
    if (publicPermission.level !== "NONE") {
      getPermissionLogger().debug("Found public permission", {
        userId,
        documentPath: normalizedPath,
        level: publicPermission.level,
      });
      return {
        level: publicPermission.level,
        inherited: false,
        explicit: false,
        publicAccess: true,
      };
    }

    // No permission found
    getPermissionLogger().debug("No permission found", {
      userId,
      documentPath: normalizedPath,
    });
    return {
      level: "NONE",
      inherited: false,
      explicit: false,
      publicAccess: false,
    };
  }

  /**
   * Get direct permission for a user on a specific path
   */
  private async getDirectPermission(
    userId: string,
    path: string,
  ): Promise<{ level: PermissionLevel; publicAccess: boolean }> {
    const permissionsResult = await this.kv.get([
      "documents",
      "permissions",
      path,
    ]);
    const permissions = permissionsResult.value as DocumentPermissions | null;

    if (!permissions) {
      return { level: "NONE", publicAccess: false };
    }

    // Check ownership
    if (permissions.owner === userId) {
      return { level: "OWNER", publicAccess: false };
    }

    // Check explicit role assignments
    if (permissions.editors?.includes(userId)) {
      return { level: "EDITOR", publicAccess: false };
    }
    if (permissions.commenters?.includes(userId)) {
      return { level: "COMMENTER", publicAccess: false };
    }
    if (permissions.viewers?.includes(userId)) {
      return { level: "VIEWER", publicAccess: false };
    }

    // Check public access
    if (permissions.public_access && permissions.public_access !== "NONE") {
      return { level: permissions.public_access, publicAccess: true };
    }

    return { level: "NONE", publicAccess: false };
  }

  /**
   * Get inherited permission from parent documents
   */
  private async getInheritedPermission(
    userId: string,
    path: string,
  ): Promise<ResolvedPermission> {
    const parentPath = this.getParentPath(path);
    if (!parentPath) {
      return {
        level: "NONE",
        inherited: false,
        explicit: false,
        publicAccess: false,
      };
    }

    // Check if parent document allows inheritance
    const parentPermissionsResult = await this.kv.get([
      "documents",
      "permissions",
      parentPath,
    ]);
    const parentPermissions = parentPermissionsResult.value as DocumentPermissions | null;

    if (!parentPermissions?.inherit_from_parent) {
      return {
        level: "NONE",
        inherited: false,
        explicit: false,
        publicAccess: false,
      };
    }

    // Get permission from parent (which may itself be inherited)
    const parentPermission = await this.resolvePermission(userId, parentPath);
    if (parentPermission.level === "NONE") {
      return {
        level: "NONE",
        inherited: false,
        explicit: false,
        publicAccess: false,
      };
    }

    // Inherit with potential level reduction
    let inheritedLevel = parentPermission.level;

    // Owners become admins when inherited (can't inherit ownership)
    if (inheritedLevel === "OWNER") {
      inheritedLevel = "ADMIN";
    }

    return {
      level: inheritedLevel,
      inherited: true,
      inheritedFrom: parentPermission.inheritedFrom || parentPath,
      explicit: false,
      publicAccess: parentPermission.publicAccess,
    };
  }

  /**
   * Get public permission level for a document
   */
  private async getPublicPermission(
    path: string,
  ): Promise<{ level: PermissionLevel; publicAccess: boolean }> {
    const permissionsResult = await this.kv.get([
      "documents",
      "permissions",
      path,
    ]);
    const permissions = permissionsResult.value as DocumentPermissions | null;

    if (
      !permissions ||
      !permissions.public_access ||
      permissions.public_access === "NONE"
    ) {
      return { level: "NONE", publicAccess: false };
    }

    return { level: permissions.public_access, publicAccess: true };
  }

  // ============================================================================
  // CASL Ability Creation
  // ============================================================================

  /**
   * Create CASL ability for a user
   */
  async createUserAbility(context: PermissionContext): Promise<AppAbility> {
    getPermissionLogger().debug("Creating user ability", {
      userId: context.userId,
    });

    const rules: Parameters<typeof createMongoAbility>[0] = [];

    // System admin has all permissions
    if (context.isAdmin) {
      rules.push({ action: "manage" as Action, subject: "all" });
      return createMongoAbility(rules as any) as AppAbility;
    }

    // Document-specific permissions
    if (context.documentPath) {
      const permission = await this.resolvePermission(
        context.userId,
        context.documentPath,
      );
      const documentRules = this.getDocumentRules(
        permission.level,
        context.documentPath,
      );
      rules.push(...documentRules);
    }

    // User can manage their own profile
    rules.push({
      action: "read" as Action,
      subject: "User",
      conditions: { id: context.userId },
    });
    rules.push({
      action: "update" as Action,
      subject: "User",
      conditions: { id: context.userId },
    });

    // Public read access to public documents
    rules.push({
      action: "read" as Action,
      subject: "Document",
      conditions: { is_public: true },
    });

    return createMongoAbility(rules as any) as AppAbility;
  }

  /**
   * Get CASL rules for a specific permission level
   */
  private getDocumentRules(
    level: PermissionLevel,
    documentPath: string,
  ): Array<any> {
    const rules: Array<any> = [];
    const conditions = { path: documentPath };

    switch (level) {
      case "OWNER":
        rules.push({ action: "manage", subject: "Document", conditions });
        rules.push({ action: "share", subject: "Document", conditions });
        rules.push({ action: "admin", subject: "Document", conditions });
        break;

      case "ADMIN":
        rules.push({
          action: "create" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "read" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "update" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "delete" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "collaborate" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "comment" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "share" as Action,
          subject: "Document",
          conditions,
        });
        break;

      case "EDITOR":
        rules.push({
          action: "read" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "update" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "collaborate" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "comment" as Action,
          subject: "Document",
          conditions,
        });
        break;

      case "COMMENTER":
        rules.push({
          action: "read" as Action,
          subject: "Document",
          conditions,
        });
        rules.push({
          action: "comment" as Action,
          subject: "Document",
          conditions,
        });
        break;

      case "VIEWER":
        rules.push({
          action: "read" as Action,
          subject: "Document",
          conditions,
        });
        break;

      case "NONE":
      default:
        // No permissions
        break;
    }

    return rules;
  }

  // ============================================================================
  // Permission Management
  // ============================================================================

  /**
   * Set permissions for a document
   */
  async setDocumentPermissions(
    documentPath: string,
    permissions: Partial<DocumentPermissions>,
    actorId: string,
  ): Promise<boolean> {
    const normalizedPath = this.normalizePath(documentPath);

    getPermissionLogger().info("Setting document permissions", {
      documentPath: normalizedPath,
      actorId,
      permissions: Object.keys(permissions),
    });

    // Check if actor has permission to modify permissions
    const actorPermission = await this.resolvePermission(
      actorId,
      normalizedPath,
    );
    if (!this.hasPermissionLevel(actorPermission.level, "ADMIN")) {
      getPermissionLogger().warn(
        "Insufficient permission to modify document permissions",
        {
          actorId,
          documentPath: normalizedPath,
          actorLevel: actorPermission.level,
        },
      );
      return false;
    }

    // Get current permissions
    const currentResult = await this.kv.get([
      "documents",
      "permissions",
      normalizedPath,
    ]);
    const current = (currentResult.value as DocumentPermissions) ||
      this.getDefaultPermissions(actorId);

    // Merge permissions
    const updated: DocumentPermissions = { ...current, ...permissions };

    // Store updated permissions
    await this.kv.set(["documents", "permissions", normalizedPath], updated);

    getPermissionLogger().info("Document permissions updated", {
      documentPath: normalizedPath,
      actorId,
    });

    return true;
  }

  /**
   * Add user to document permission list
   */
  async grantDocumentPermission(
    documentPath: string,
    userId: string,
    level: PermissionLevel,
    actorId: string,
  ): Promise<boolean> {
    const normalizedPath = this.normalizePath(documentPath);

    getPermissionLogger().info("Granting document permission", {
      documentPath: normalizedPath,
      userId,
      level,
      actorId,
    });

    // Check if actor has permission to grant permissions
    const actorPermission = await this.resolvePermission(
      actorId,
      normalizedPath,
    );
    if (!this.hasPermissionLevel(actorPermission.level, "ADMIN")) {
      return false;
    }

    // Get current permissions
    const currentResult = await this.kv.get([
      "documents",
      "permissions",
      normalizedPath,
    ]);
    const current = (currentResult.value as DocumentPermissions) ||
      this.getDefaultPermissions(actorId);

    // Remove from other lists first
    this.removeUserFromPermissionLists(current, userId);

    // Add to appropriate list
    switch (level) {
      case "EDITOR":
        current.editors = current.editors || [];
        current.editors.push(userId);
        break;
      case "COMMENTER":
        current.commenters = current.commenters || [];
        current.commenters.push(userId);
        break;
      case "VIEWER":
        current.viewers = current.viewers || [];
        current.viewers.push(userId);
        break;
      case "OWNER":
        current.owner = userId;
        break;
        // ADMIN and NONE are handled differently
    }

    await this.kv.set(["documents", "permissions", normalizedPath], current);

    getPermissionLogger().info("Document permission granted", {
      documentPath: normalizedPath,
      userId,
      level,
      actorId,
    });

    return true;
  }

  /**
   * Revoke user permission from document
   */
  async revokeDocumentPermission(
    documentPath: string,
    userId: string,
    actorId: string,
  ): Promise<boolean> {
    const normalizedPath = this.normalizePath(documentPath);

    getPermissionLogger().info("Revoking document permission", {
      documentPath: normalizedPath,
      userId,
      actorId,
    });

    // Check if actor has permission to revoke permissions
    const actorPermission = await this.resolvePermission(
      actorId,
      normalizedPath,
    );
    if (!this.hasPermissionLevel(actorPermission.level, "ADMIN")) {
      return false;
    }

    // Get current permissions
    const currentResult = await this.kv.get([
      "documents",
      "permissions",
      normalizedPath,
    ]);
    const current = currentResult.value as DocumentPermissions;

    if (!current) return true; // Nothing to revoke

    // Remove from all permission lists
    this.removeUserFromPermissionLists(current, userId);

    await this.kv.set(["documents", "permissions", normalizedPath], current);

    getPermissionLogger().info("Document permission revoked", {
      documentPath: normalizedPath,
      userId,
      actorId,
    });

    return true;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Normalize document path
   */
  private normalizePath(path: string): string {
    return path
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/")
        .startsWith("/")
      ? path
      : `/${path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")}`;
  }

  /**
   * Get parent path
   */
  private getParentPath(path: string): string | null {
    const components = path.replace(/^\/+|\/+$/g, "").split("/");
    if (components.length <= 1) return null;
    return `/${components.slice(0, -1).join("/")}`;
  }

  /**
   * Get default permissions for a new document
   */
  private getDefaultPermissions(ownerId: string): DocumentPermissions {
    return {
      owner: ownerId,
      editors: [],
      viewers: [],
      commenters: [],
      inheritFromParent: true,
      inherit_from_parent: true,
      publicAccess: "NONE",
      public_access: "NONE",
    };
  }

  /**
   * Remove user from all permission lists
   */
  private removeUserFromPermissionLists(
    permissions: DocumentPermissions,
    userId: string,
  ): void {
    if (permissions.editors) {
      permissions.editors = permissions.editors.filter((id) => id !== userId);
    }
    if (permissions.commenters) {
      permissions.commenters = permissions.commenters.filter(
        (id) => id !== userId,
      );
    }
    if (permissions.viewers) {
      permissions.viewers = permissions.viewers.filter((id) => id !== userId);
    }
  }

  /**
   * Get all users with permission to a document
   */
  async getDocumentUsers(documentPath: string): Promise<{
    owner: string;
    editors: string[];
    commenters: string[];
    viewers: string[];
    publicAccess: PermissionLevel;
  }> {
    const normalizedPath = this.normalizePath(documentPath);
    const result = await this.kv.get([
      "documents",
      "permissions",
      normalizedPath,
    ]);
    const permissions = result.value as DocumentPermissions;

    if (!permissions) {
      return {
        owner: "",
        editors: [],
        commenters: [],
        viewers: [],
        publicAccess: "NONE",
      };
    }

    return {
      owner: permissions.owner,
      editors: permissions.editors || [],
      commenters: permissions.commenters || [],
      viewers: permissions.viewers || [],
      publicAccess: permissions.public_access || "NONE",
    };
  }

  /**
   * Check if user can perform action on document
   */
  async can(
    userId: string,
    action: Action,
    documentPath: string,
  ): Promise<boolean> {
    const context: PermissionContext = {
      userId,
      username: "", // We'd need to look this up
      documentPath,
    };

    const ability = await this.createUserAbility(context);
    return ability.can(action, "Document");
  }

  /**
   * Validate permission level
   */
  isValidPermissionLevel(level: string): level is PermissionLevel {
    return ["NONE", "VIEWER", "COMMENTER", "EDITOR", "ADMIN", "OWNER"].includes(
      level,
    );
  }

  /**
   * Get document permissions
   */
  async getDocumentPermissions(
    documentPath: string,
  ): Promise<DocumentPermissions> {
    const normalizedPath = this.normalizePath(documentPath);

    try {
      const result = await this.kv.get([
        "documents",
        "permissions",
        normalizedPath,
      ]);

      if (result.value) {
        return result.value as DocumentPermissions;
      }

      // Return default permissions if not found
      return {
        inheritFromParent: true,
        inherit_from_parent: true,
        publicAccess: "NONE",
        public_access: "NONE",
        owner: "",
        editors: [],
        commenters: [],
        viewers: [],
      };
    } catch (error) {
      getPermissionLogger().error("Failed to get document permissions", {
        documentPath: normalizedPath,
        error: (error as Error).message,
      });

      // Return default permissions on error
      return {
        inheritFromParent: true,
        inherit_from_parent: true,
        publicAccess: "NONE",
        public_access: "NONE",
        owner: "",
        editors: [],
        commenters: [],
        viewers: [],
      };
    }
  }
}

/**
 * Create permission service instance
 */
export async function createPermissionService(
  kv: Deno.Kv,
  configService: ConfigService,
): Promise<PermissionService> {
  const service = new PermissionService(kv, configService);

  getPermissionLogger().info("Permission service initialized");

  return service;
}

/**
 * Helper functions for permission checking
 */
export const PermissionUtils = {
  /**
   * Check if permission level meets requirement
   */
  hasLevel(
    userLevel: PermissionLevel,
    requiredLevel: PermissionLevel,
  ): boolean {
    const levels = {
      NONE: 0,
      VIEWER: 1,
      COMMENTER: 2,
      EDITOR: 3,
      ADMIN: 4,
      OWNER: 5,
    };
    return (levels[userLevel] || 0) >= (levels[requiredLevel] || 0);
  },

  /**
   * Get actions allowed for permission level
   */
  getActionsForLevel(level: PermissionLevel): Action[] {
    switch (level) {
      case "OWNER":
        return [
          "create",
          "read",
          "update",
          "delete",
          "comment",
          "collaborate",
          "share",
          "admin",
        ];
      case "ADMIN":
        return [
          "create",
          "read",
          "update",
          "delete",
          "comment",
          "collaborate",
          "share",
        ];
      case "EDITOR":
        return ["read", "update", "comment", "collaborate"];
      case "COMMENTER":
        return ["read", "comment"];
      case "VIEWER":
        return ["read"];
      case "NONE":
      default:
        return [];
    }
  },

  /**
   * Check if level can perform action
   */
  canPerformAction(level: PermissionLevel, action: Action): boolean {
    return this.getActionsForLevel(level).includes(action);
  },
};
