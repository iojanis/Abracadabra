// File Upload Routes for Abracadabra Server
// Handles document attachments and file management

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUploadsService } from "../services/uploads.ts";
import type { FileMetadataObject } from "../types/index.ts";

// Validation schemas
const UploadSchema = z.object({
  filename: z.string().min(1).max(255),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  documentPath: z.string().optional(),
});

const FileQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 50)),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 0)),
});

export class UploadRoutes {
  private app: Hono;

  constructor() {
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Upload a file
    this.app.post("/", zValidator("form", UploadSchema), async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const formData = await c.req.formData();
        const file = formData.get("file") as File;
        const data = c.req.valid("form");

        if (!file) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "No file provided",
              },
            },
            400,
          );
        }

        // Convert file to buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);

        const uploadsService = getUploadsService();
        const result = await uploadsService.uploadFile({
          userId,
          filename: data.filename || file.name,
          mimeType: file.type,
          size: file.size,
          buffer,
          ...(data.description && { description: data.description }),
          ...(data.tags && { tags: data.tags }),
          ...(data.documentPath && { documentPath: data.documentPath }),
        });

        if (!result.success) {
          return c.json(
            {
              error: {
                code: "UPLOAD_FAILED",
                message: result.error || "Upload failed",
              },
            },
            400,
          );
        }

        return c.json(
          {
            success: true,
            data: {
              fileId: result.fileId,
              filename: result.filename,
              url: result.url,
              size: result.size,
            },
          },
          201,
        );
      } catch (error) {
        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Upload processing failed",
            },
          },
          500,
        );
      }
    });

    // Get file metadata
    this.app.get("/:fileId", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const fileId = c.req.param("fileId");

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const uploadsService = getUploadsService();
        const metadata = await uploadsService.getFile(fileId);

        if (!metadata) {
          return c.json(
            {
              error: {
                code: "FILE_NOT_FOUND",
                message: "File not found",
              },
            },
            404,
          );
        }

        // Check access permissions
        if (metadata.uploadedBy !== userId) {
          if (metadata.documentPath) {
            // Will be checked by the service
          } else {
            return c.json(
              {
                error: {
                  code: "PERMISSION_DENIED",
                  message: "Access denied",
                },
              },
              403,
            );
          }
        }

        return c.json({
          success: true,
          data: metadata,
        });
      } catch (error) {
        if ((error as Error).message.includes("permission")) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Access denied",
              },
            },
            403,
          );
        }

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to retrieve file metadata",
            },
          },
          500,
        );
      }
    });

    // Download a file
    this.app.get("/:fileId/download", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const fileId = c.req.param("fileId");

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const uploadsService = getUploadsService();
        const result = await uploadsService.downloadFile(fileId, userId);

        if (!result) {
          return c.json(
            {
              error: {
                code: "FILE_NOT_FOUND",
                message: "File not found",
              },
            },
            404,
          );
        }

        // Set appropriate headers
        c.header("Content-Type", result.metadata.mimeType);
        c.header("Content-Length", result.metadata.size.toString());
        c.header(
          "Content-Disposition",
          `attachment; filename="${result.metadata.filename}"`,
        );
        c.header("Cache-Control", "private, max-age=3600");

        return c.body(result.data);
      } catch (error) {
        if ((error as Error).message.includes("permission")) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Access denied",
              },
            },
            403,
          );
        }

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to download file",
            },
          },
          500,
        );
      }
    });

    // Delete a file
    this.app.delete("/:fileId", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;
        const fileId = c.req.param("fileId");

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const uploadsService = getUploadsService();
        const success = await uploadsService.deleteFile(fileId, userId);

        if (!success) {
          return c.json(
            {
              error: {
                code: "FILE_NOT_FOUND",
                message: "File not found",
              },
            },
            404,
          );
        }

        return c.json({
          success: true,
          message: "File deleted successfully",
        });
      } catch (error) {
        if ((error as Error).message.includes("permission")) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Access denied",
              },
            },
            403,
          );
        }

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to delete file",
            },
          },
          500,
        );
      }
    });

    // List user's files
    this.app.get("/", zValidator("query", FileQuerySchema), async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const { limit, offset } = c.req.valid("query");

        const uploadsService = getUploadsService();
        const files = await uploadsService.listUserFiles(userId, limit, offset);

        return c.json({
          success: true,
          data: {
            files,
            pagination: {
              limit,
              offset,
              total: files.length,
            },
          },
        });
      } catch (error) {
        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to list files",
            },
          },
          500,
        );
      }
    });

    // List files for a document
    this.app.get("/document/*", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const documentPath =
          c.req.path.replace("/api/uploads/document", "") || "/";

        const uploadsService = getUploadsService();
        const files = await uploadsService.listDocumentFiles(
          documentPath,
          userId,
        );

        return c.json({
          success: true,
          data: {
            documentPath,
            files,
          },
        });
      } catch (error) {
        if ((error as Error).message.includes("permission")) {
          return c.json(
            {
              error: {
                code: "PERMISSION_DENIED",
                message: "Access denied",
              },
            },
            403,
          );
        }

        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to list document files",
            },
          },
          500,
        );
      }
    });

    // Get upload statistics
    this.app.get("/stats", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        const uploadsService = getUploadsService();
        const stats = await uploadsService.getUploadStats(userId);

        return c.json({
          success: true,
          data: stats,
        });
      } catch (error) {
        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to get upload statistics",
            },
          },
          500,
        );
      }
    });

    // Cleanup orphaned files (admin only)
    this.app.post("/cleanup", async (c) => {
      try {
        const session = (c as any).get("session");
        const userId = session?.userId;

        if (!userId) {
          return c.json(
            {
              error: {
                code: "AUTHENTICATION_REQUIRED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        // TODO: Check if user is admin
        // For now, allow any authenticated user

        const uploadsService = getUploadsService();
        const cleanedCount = await uploadsService.cleanupOrphanedFiles();

        return c.json({
          success: true,
          data: {
            cleanedFiles: cleanedCount,
          },
        });
      } catch (error) {
        return c.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to cleanup files",
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

export default UploadRoutes;
