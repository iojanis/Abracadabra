// Document Management API Routes for Abracadabra Server
// Handles hierarchical document CRUD operations, permissions, and collaboration

import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";

import type {
  DocumentMetadataObject,
  DocumentDetails,
  DocumentPermissions,
  PermissionLevel,
  ApiResponse,
  ApiError,
  DocumentCreateOptions,
  DocumentUpdateOptions,
  DocumentListOptions,
  DocumentSearchOptions,
} from "../types/index.ts";
import type { DocumentService } from "../services/documents.ts";
import type { PermissionService } from "../services/permissions.ts";
import { getLogger } from "../services/logging.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getDocumentRouteLogger() {
  if (!logger) {
    logger = getLogger(["routes", "documents"]);
  }
  return logger;
}

// Validation schemas
const documentCreateSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(200, "Title must be at most 200 characters")
    .optional(),
  description: z
    .string()
    .max(1000, "Description must be at most 1000 characters")
    .optional(),
  initialContent: z.string().optional(),
  isPublic: z.boolean().optional(),
  permissions: z
    .object({
      inheritFromParent: z.boolean().optional(),
      publicAccess: z
        .enum(["NONE", "VIEWER", "COMMENTER", "EDITOR", "ADMIN", "OWNER"])
        .optional(),
      editors: z.array(z.string()).optional(),
      commenters: z.array(z.string()).optional(),
      viewers: z.array(z.string()).optional(),
    })
    .optional(),
});

const documentUpdateSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(200, "Title must be at most 200 characters")
    .optional(),
  description: z
    .string()
    .max(1000, "Description must be at most 1000 characters")
    .optional(),
  tags: z.array(z.string()).optional(),
  isPublic: z.boolean().optional(),
});

const searchSchema = z.object({
  query: z.string().min(1, "Query is required"),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
  onlyPublic: z.boolean().optional(),
});

const permissionGrantSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  level: z.enum(["NONE", "VIEWER", "COMMENTER", "EDITOR", "ADMIN", "OWNER"]),
});

const permissionUpdateSchema = z.object({
  inheritFromParent: z.boolean().optional(),
  publicAccess: z
    .enum(["NONE", "VIEWER", "COMMENTER", "EDITOR", "ADMIN", "OWNER"])
    .optional(),
  editors: z.array(z.string()).optional(),
  commenters: z.array(z.string()).optional(),
  viewers: z.array(z.string()).optional(),
});

export class DocumentRoutes {
  private kv: Deno.Kv;
  private app: Hono;
  private documentService: DocumentService;
  private permissionService: PermissionService;

  constructor(
    kv: Deno.Kv,
    documentService: DocumentService,
    permissionService: PermissionService,
  ) {
    this.kv = kv;
    this.documentService = documentService;
    this.permissionService = permissionService;
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes() {
    // List user's documents
    this.app.get("/", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const username = session?.username;

        if (!userId || !username) {
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

        const limit = parseInt(c.req.query("limit") || "50");
        const offset = parseInt(c.req.query("offset") || "0");
        const includePermissions = c.req.query("includePermissions") === "true";
        const includeChildren = c.req.query("includeChildren") === "true";

        const options: DocumentListOptions = {
          limit,
          offset,
          includePermissions,
          includeChildren,
        };

        const documents = await this.documentService.listUserDocuments(
          username,
          options,
        );

        return c.json({
          data: {
            documents,
            meta: {
              limit,
              offset,
              total: documents.length,
              hasMore: documents.length === limit,
            },
          },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error listing documents", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to list documents",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Create new document
    this.app.post(
      "/*",
      validator("json", (value, c) => {
        const result = documentCreateSchema.safeParse(value);
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
          const session = (c as any).get("session");
          const userId = session?.userId;
          const username = session?.username;

          if (!userId || !username) {
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

          const data = c.req.valid("json");
          const path =
            c.req.path.replace("/api/documents", "") || `/${username}/untitled`;

          // Ensure path starts with username
          const normalizedPath = path.startsWith(`/${username}`)
            ? path
            : `/${username}${path.startsWith("/") ? "" : "/"}${path}`;

          getDocumentRouteLogger().info("Creating document", {
            path: normalizedPath,
            userId,
            username,
          });

          // Check if user can create in this location
          const parentPath = this.documentService.getParentPath(normalizedPath);
          if (parentPath) {
            const canCreate = await this.permissionService.can(
              userId,
              "create",
              parentPath,
            );
            if (!canCreate) {
              return c.json(
                {
                  error: {
                    code: "PERMISSION_DENIED",
                    message:
                      "Insufficient permissions to create document in this location",
                    timestamp: new Date().toISOString(),
                  },
                },
                403,
              );
            }
          }

          const document = await this.documentService.createDocument(
            normalizedPath,
            userId,
            data as DocumentCreateOptions,
          );

          return c.json(
            {
              data: { document },
            },
            201,
          );
        } catch (error) {
          getDocumentRouteLogger().error("Error creating document", {
            error: (error as Error).message,
          });

          if ((error as Error).message.includes("already exists")) {
            return c.json(
              {
                error: {
                  code: "DUPLICATE_RESOURCE",
                  message: "Document already exists at this path",
                  timestamp: new Date().toISOString(),
                },
              },
              409,
            );
          }

          if ((error as Error).message.includes("Invalid path")) {
            return c.json(
              {
                error: {
                  code: "INVALID_PATH",
                  message: "Invalid document path",
                  timestamp: new Date().toISOString(),
                },
              },
              400,
            );
          }

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to create document",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Get document
    this.app.get("/*", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const path = c.req.path.replace("/api/documents", "") || "/";

        if (!path || path === "/") {
          // This is handled by the list documents route
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        getDocumentRouteLogger().debug("Getting document", { path, userId });

        // Check permissions
        if (userId) {
          const canRead = await this.permissionService.can(
            userId,
            "read",
            path,
          );
          if (!canRead) {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message: "Insufficient permissions to read document",
                  timestamp: new Date().toISOString(),
                },
              },
              403,
            );
          }
        } else {
          // Check if document is public
          const permissions =
            await this.permissionService.getDocumentPermissions(path);
          if (!permissions || permissions.publicAccess === "NONE") {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message: "Authentication required to access this document",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }
        }

        const includePermissions = c.req.query("includePermissions") === "true";
        const includeChildren = c.req.query("includeChildren") === "true";

        const options: DocumentListOptions = {
          includePermissions,
          includeChildren,
        };

        const document = await this.documentService.getDocument(path, options);

        if (!document) {
          return c.json(
            {
              error: {
                code: "DOCUMENT_NOT_FOUND",
                message: "Document not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        return c.json({
          data: { document },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error getting document", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get document",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Update document
    this.app.put(
      "/*",
      validator("json", (value, c) => {
        const result = documentUpdateSchema.safeParse(value);
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
          const session = (c as any).get("session");
          const userId = session?.userId;
          const path = c.req.path.replace("/api/documents", "");

          if (!userId) {
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

          if (!path || path === "/") {
            return c.json(
              {
                error: {
                  code: "INVALID_PATH",
                  message: "Invalid document path",
                  timestamp: new Date().toISOString(),
                },
              },
              400,
            );
          }

          // Check permissions
          const canUpdate = await this.permissionService.can(
            userId,
            "update",
            path,
          );
          if (!canUpdate) {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message: "Insufficient permissions to update document",
                  timestamp: new Date().toISOString(),
                },
              },
              403,
            );
          }

          const data = c.req.valid("json");

          const updatedDocument = await this.documentService.updateDocument(
            path,
            userId,
            data as DocumentUpdateOptions,
          );

          if (!updatedDocument) {
            return c.json(
              {
                error: {
                  code: "DOCUMENT_NOT_FOUND",
                  message: "Document not found",
                  timestamp: new Date().toISOString(),
                },
              },
              404,
            );
          }

          return c.json({
            data: { document: updatedDocument },
          });
        } catch (error) {
          getDocumentRouteLogger().error("Error updating document", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to update document",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Delete document
    this.app.delete("/*", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const path = c.req.path.replace("/api/documents", "");

        if (!userId) {
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

        if (!path || path === "/") {
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        // Check permissions
        const canDelete = await this.permissionService.can(
          userId,
          "delete",
          path,
        );
        if (!canDelete) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Insufficient permissions to delete document",
                timestamp: new Date().toISOString(),
              },
            },
            403,
          );
        }

        const deleted = await this.documentService.deleteDocument(path, userId);

        if (!deleted) {
          return c.json(
            {
              error: {
                code: "DOCUMENT_NOT_FOUND",
                message: "Document not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        return c.json({
          data: { message: "Document deleted successfully" },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error deleting document", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to delete document",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Search documents
    this.app.post(
      "/search",
      validator("json", (value, c) => {
        const result = searchSchema.safeParse(value);
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
          const session = (c as any).get("session");
          const userId = session?.userId;
          const data = c.req.valid("json");

          const options: DocumentSearchOptions = {
            limit: data.limit || 50,
            offset: data.offset || 0,
            onlyPublic: data.onlyPublic || false,
          };

          const documents = await this.documentService.searchDocuments(
            data.query,
            userId,
            options,
          );

          return c.json({
            data: {
              documents,
              meta: {
                query: data.query,
                limit: options.limit,
                offset: options.offset,
                total: documents.length,
                hasMore: documents.length === options.limit,
              },
            },
          });
        } catch (error) {
          getDocumentRouteLogger().error("Error searching documents", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to search documents",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Get document children
    this.app.get("/*/children", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const path = c.req.path
          .replace("/api/documents", "")
          .replace("/children", "");

        if (!path) {
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        // Check permissions
        if (userId) {
          const canRead = await this.permissionService.can(
            userId,
            "read",
            path,
          );
          if (!canRead) {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message: "Insufficient permissions to read document",
                  timestamp: new Date().toISOString(),
                },
              },
              403,
            );
          }
        }

        const limit = parseInt(c.req.query("limit") || "50");
        const offset = parseInt(c.req.query("offset") || "0");

        const options: DocumentListOptions = { limit, offset };
        const children = await this.documentService.listChildren(path, options);

        return c.json({
          data: {
            children,
            meta: {
              limit,
              offset,
              total: children.length,
              hasMore: children.length === limit,
            },
          },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error getting document children", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get document children",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Get document permissions
    this.app.get("/*/permissions", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const path = c.req.path
          .replace("/api/documents", "")
          .replace("/permissions", "");

        if (!userId) {
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

        if (!path) {
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        // Check if user can view permissions (admin or owner)
        const canAdmin = await this.permissionService.can(
          userId,
          "admin",
          path,
        );
        if (!canAdmin) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message:
                  "Insufficient permissions to view document permissions",
                timestamp: new Date().toISOString(),
              },
            },
            403,
          );
        }

        const permissions =
          await this.permissionService.getDocumentPermissions(path);

        if (!permissions) {
          return c.json(
            {
              error: {
                code: "DOCUMENT_NOT_FOUND",
                message: "Document not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        return c.json({
          data: { permissions },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error getting document permissions", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get document permissions",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Update document permissions
    this.app.put(
      "/*/permissions",
      validator("json", (value, c) => {
        const result = permissionUpdateSchema.safeParse(value);
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
          const session = (c as any).get("session");
          const userId = session?.userId;
          const path = c.req.path
            .replace("/api/documents", "")
            .replace("/permissions", "");
          const data = c.req.valid("json");

          if (!userId) {
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

          if (!path) {
            return c.json(
              {
                error: {
                  code: "INVALID_PATH",
                  message: "Invalid document path",
                  timestamp: new Date().toISOString(),
                },
              },
              400,
            );
          }

          const success = await this.permissionService.setDocumentPermissions(
            path,
            {
              ...(data.inheritFromParent !== undefined && {
                inheritFromParent: data.inheritFromParent,
              }),
              ...(data.publicAccess !== undefined && {
                publicAccess: data.publicAccess,
              }),
              ...(data.editors !== undefined && { editors: data.editors }),
              ...(data.commenters !== undefined && {
                commenters: data.commenters,
              }),
              ...(data.viewers !== undefined && { viewers: data.viewers }),
            },
            userId,
          );

          if (!success) {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message:
                    "Insufficient permissions to modify document permissions",
                  timestamp: new Date().toISOString(),
                },
              },
              403,
            );
          }

          return c.json({
            data: { message: "Permissions updated successfully" },
          });
        } catch (error) {
          getDocumentRouteLogger().error(
            "Error updating document permissions",
            {
              error: (error as Error).message,
            },
          );

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to update document permissions",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Grant permission
    this.app.post(
      "/*/permissions/grant",
      validator("json", (value, c) => {
        const result = permissionGrantSchema.safeParse(value);
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
          const session = (c as any).get("session");
          const userId = session?.userId;
          const path = c.req.path
            .replace("/api/documents", "")
            .replace("/permissions/grant", "");
          const data = c.req.valid("json");

          if (!userId) {
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

          if (!path) {
            return c.json(
              {
                error: {
                  code: "INVALID_PATH",
                  message: "Invalid document path",
                  timestamp: new Date().toISOString(),
                },
              },
              400,
            );
          }

          const success = await this.permissionService.grantDocumentPermission(
            path,
            data.userId,
            data.level,
            userId,
          );

          if (!success) {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message:
                    "Insufficient permissions to grant document permission",
                  timestamp: new Date().toISOString(),
                },
              },
              403,
            );
          }

          return c.json({
            data: { message: "Permission granted successfully" },
          });
        } catch (error) {
          getDocumentRouteLogger().error("Error granting document permission", {
            error: (error as Error).message,
          });

          return c.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to grant document permission",
                timestamp: new Date().toISOString(),
              },
            },
            500,
          );
        }
      },
    );

    // Revoke permission
    this.app.post("/*/permissions/revoke", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const targetUserId = c.req.query("userId");
        const path = c.req.path
          .replace("/api/documents", "")
          .replace("/permissions/revoke", "");

        if (!userId) {
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

        if (!path) {
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        if (!targetUserId) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "User ID is required",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        const success = await this.permissionService.revokeDocumentPermission(
          path,
          targetUserId,
          userId,
        );

        if (!success) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message:
                  "Insufficient permissions to revoke document permission",
                timestamp: new Date().toISOString(),
              },
            },
            403,
          );
        }

        return c.json({
          data: { message: "Permission revoked successfully" },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error revoking document permission", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to revoke document permission",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Get document statistics
    this.app.get("/*/stats", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const path = c.req.path
          .replace("/api/documents", "")
          .replace("/stats", "");

        if (!path) {
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        // Check permissions if user is authenticated
        if (userId) {
          const canRead = await this.permissionService.can(
            userId,
            "read",
            path,
          );
          if (!canRead) {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message:
                    "Insufficient permissions to view document statistics",
                  timestamp: new Date().toISOString(),
                },
              },
              403,
            );
          }
        } else {
          // Check if document is public
          const permissions =
            await this.permissionService.getDocumentPermissions(path);
          if (!permissions || permissions.publicAccess === "NONE") {
            return c.json(
              {
                error: {
                  code: "AUTHENTICATION_REQUIRED",
                  message:
                    "Authentication required to access document statistics",
                  timestamp: new Date().toISOString(),
                },
              },
              401,
            );
          }
        }

        const stats = await this.documentService.getDocumentStats(path);

        return c.json({
          data: { stats },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error getting document statistics", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get document statistics",
              timestamp: new Date().toISOString(),
            },
          },
          500,
        );
      }
    });

    // Get Yjs document state
    this.app.get("/*/yjs", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const path = c.req.path
          .replace("/api/documents", "")
          .replace("/yjs", "");

        if (!userId) {
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

        if (!path) {
          return c.json(
            {
              error: {
                code: "INVALID_PATH",
                message: "Invalid document path",
                timestamp: new Date().toISOString(),
              },
            },
            400,
          );
        }

        // Check permissions
        const canRead = await this.permissionService.can(userId, "read", path);
        if (!canRead) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Insufficient permissions to read document",
                timestamp: new Date().toISOString(),
              },
            },
            403,
          );
        }

        const yjsState = await this.documentService.getYjsDocument(path);

        if (!yjsState) {
          return c.json(
            {
              error: {
                code: "DOCUMENT_NOT_FOUND",
                message: "Document not found",
                timestamp: new Date().toISOString(),
              },
            },
            404,
          );
        }

        // Return binary data with appropriate content type
        return new Response(yjsState, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": yjsState.length.toString(),
          },
        });
      } catch (error) {
        getDocumentRouteLogger().error("Error getting Yjs document", {
          error: (error as Error).message,
        });

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get Yjs document",
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

export function createDocumentRoutes(
  kv: Deno.Kv,
  documentService: DocumentService,
  permissionService: PermissionService,
): Hono {
  const documentRoutes = new DocumentRoutes(
    kv,
    documentService,
    permissionService,
  );
  return documentRoutes.getApp();
}
