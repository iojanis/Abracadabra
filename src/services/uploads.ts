// File Upload Service for Abracadabra Server
// Handles document attachments with local and S3 storage support

import { getLogger } from "./logging.ts";
import type { ConfigService } from "./config.ts";
import type { PermissionService } from "./permissions.ts";
import type { FileMetadataObject } from "../types/index.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getUploadLogger() {
  if (!logger) {
    logger = getLogger(["uploads"]);
  }
  return logger;
}

// Upload configuration and interfaces
export interface UploadConfig {
  maxFileSize: number; // bytes
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  uploadPath: string;
  useS3: boolean;
  s3Bucket?: string | undefined;
  s3Region?: string | undefined;
  s3AccessKeyId?: string | undefined;
  s3SecretAccessKey?: string | undefined;
}

export interface UploadResult {
  success: boolean;
  fileId?: string;
  filename?: string;
  url?: string;
  size?: number;
  error?: string;
}

export interface UploadOptions {
  userId: string;
  documentPath?: string;
  filename: string;
  mimeType: string;
  size: number;
  buffer: Uint8Array;
  description?: string;
  tags?: string[];
}

export interface StorageProvider {
  store(
    fileId: string,
    buffer: Uint8Array,
    metadata: FileMetadataObject,
  ): Promise<string>;
  retrieve(fileId: string): Promise<Uint8Array>;
  delete(fileId: string): Promise<boolean>;
  exists(fileId: string): Promise<boolean>;
  getUrl(fileId: string): Promise<string>;
}

// Local storage provider
export class LocalStorageProvider implements StorageProvider {
  private uploadPath: string;

  constructor(uploadPath: string) {
    this.uploadPath = uploadPath;
    // Ensure upload directory exists
    try {
      Deno.mkdirSync(this.uploadPath, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
      }
    }
  }

  async store(
    fileId: string,
    buffer: Uint8Array,
    metadata: FileMetadataObject,
  ): Promise<string> {
    const filePath = this.getFilePath(fileId);
    await Deno.writeFile(filePath, buffer);

    getUploadLogger().info("File stored locally", {
      fileId,
      filename: metadata.filename,
      size: metadata.size,
      path: filePath,
    });

    return filePath;
  }

  async retrieve(fileId: string): Promise<Uint8Array> {
    const filePath = this.getFilePath(fileId);
    return await Deno.readFile(filePath);
  }

  async delete(fileId: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(fileId);
      await Deno.remove(filePath);
      return true;
    } catch (error) {
      getUploadLogger().error("Failed to delete local file", {
        fileId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  async exists(fileId: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(fileId);
      await Deno.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getUrl(fileId: string): Promise<string> {
    // For local storage, return a download URL
    return `/api/uploads/${fileId}/download`;
  }

  private getFilePath(fileId: string): string {
    // Create subdirectories based on file ID for better organization
    const subDir = fileId.slice(0, 2);
    const dirPath = `${this.uploadPath}/${subDir}`;

    try {
      Deno.mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
      }
    }

    return `${dirPath}/${fileId}`;
  }
}

// S3 storage provider (placeholder for future implementation)
export class S3StorageProvider implements StorageProvider {
  private bucket: string;
  private region: string;
  private accessKeyId: string;
  private secretAccessKey: string;

  constructor(
    bucket: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    this.bucket = bucket;
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
  }

  async store(
    fileId: string,
    buffer: Uint8Array,
    metadata: FileMetadataObject,
  ): Promise<string> {
    // TODO: Implement S3 upload using AWS SDK
    throw new Error("S3 storage provider not implemented yet");
  }

  async retrieve(fileId: string): Promise<Uint8Array> {
    // TODO: Implement S3 download
    throw new Error("S3 storage provider not implemented yet");
  }

  async delete(fileId: string): Promise<boolean> {
    // TODO: Implement S3 delete
    throw new Error("S3 storage provider not implemented yet");
  }

  async exists(fileId: string): Promise<boolean> {
    // TODO: Implement S3 exists check
    throw new Error("S3 storage provider not implemented yet");
  }

  async getUrl(fileId: string): Promise<string> {
    // TODO: Generate S3 presigned URL
    throw new Error("S3 storage provider not implemented yet");
  }
}

export class UploadsService {
  private kv: Deno.Kv;
  private config: ConfigService;
  private permissionService: PermissionService;
  private storageProvider!: StorageProvider;
  private uploadConfig!: UploadConfig;

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
   * Initialize the uploads service with configuration
   */
  async initialize(): Promise<void> {
    // Load upload configuration
    this.uploadConfig = {
      maxFileSize: (await this.config.get<number>("uploads.max_file_size")) ?? 10485760, // 10MB
      allowedMimeTypes: (await this.config.get<string[]>(
        "uploads.allowed_mime_types",
      )) ?? [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "application/json",
        "text/markdown",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      allowedExtensions: (await this.config.get<string[]>(
        "uploads.allowed_extensions",
      )) ?? [
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".pdf",
        ".txt",
        ".json",
        ".md",
        ".docx",
        ".xlsx",
      ],
      uploadPath: (await this.config.get<string>("uploads.local_path")) ?? "./uploads",
      useS3: (await this.config.get<boolean>("uploads.use_s3")) ?? false,
      s3Bucket: (await this.config.get<string>("uploads.s3_bucket")) ?? undefined,
      s3Region: (await this.config.get<string>("uploads.s3_region")) ?? undefined,
      s3AccessKeyId: (await this.config.get<string>("uploads.s3_access_key_id")) ??
        undefined,
      s3SecretAccessKey: (await this.config.get<string>("uploads.s3_secret_access_key")) ??
        undefined,
    };

    // Initialize storage provider
    if (this.uploadConfig.useS3 && this.uploadConfig.s3Bucket) {
      this.storageProvider = new S3StorageProvider(
        this.uploadConfig.s3Bucket,
        this.uploadConfig.s3Region!,
        this.uploadConfig.s3AccessKeyId!,
        this.uploadConfig.s3SecretAccessKey!,
      );
      getUploadLogger().info("S3 storage provider initialized", {
        bucket: this.uploadConfig.s3Bucket,
        region: this.uploadConfig.s3Region,
      });
    } else {
      this.storageProvider = new LocalStorageProvider(
        this.uploadConfig.uploadPath,
      );
      getUploadLogger().info("Local storage provider initialized", {
        uploadPath: this.uploadConfig.uploadPath,
      });
    }
  }

  /**
   * Upload a file
   */
  async uploadFile(options: UploadOptions): Promise<UploadResult> {
    try {
      getUploadLogger().info("Processing file upload", {
        userId: options.userId,
        filename: options.filename,
        mimeType: options.mimeType,
        size: options.size,
      });

      // Validate file
      const validation = await this.validateFile(options);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error || "Validation failed",
        };
      }

      // Check permissions if document path is provided
      if (options.documentPath) {
        const permission = await this.permissionService.resolvePermission(
          options.userId,
          options.documentPath,
        );

        if (
          !this.permissionService.hasPermissionLevel(permission.level, "EDITOR")
        ) {
          return {
            success: false,
            error: "Insufficient permissions to upload files to this document",
          };
        }
      }

      // Generate file ID and create metadata
      const fileId = crypto.randomUUID();
      const now = new Date();

      const metadata: FileMetadataObject = {
        id: fileId,
        filename: options.filename,
        originalFilename: options.filename,
        mimeType: options.mimeType,
        size: options.size,
        uploadedBy: options.userId,
        uploadedAt: now,
        ...(options.documentPath && { documentPath: options.documentPath }),
        ...(options.description && { description: options.description }),
        tags: options.tags || [],
        downloadCount: 0,
        storageProvider: this.uploadConfig.useS3 ? "s3" : "local",
      };

      // Store file
      const storagePath = await this.storageProvider.store(
        fileId,
        options.buffer,
        metadata,
      );
      metadata.storagePath = storagePath;

      // Store metadata in KV
      await this.kv.set(["uploads", "files", fileId], metadata);

      // Create user index
      await this.kv.set(["uploads", "by_user", options.userId, fileId], fileId);

      // Create document index if document path provided
      if (options.documentPath) {
        await this.kv.set(
          ["uploads", "by_document", options.documentPath, fileId],
          fileId,
        );
      }

      // Get file URL
      const url = await this.storageProvider.getUrl(fileId);

      getUploadLogger().info("File uploaded successfully", {
        fileId,
        userId: options.userId,
        filename: options.filename,
        size: options.size,
      });

      return {
        success: true,
        fileId,
        filename: options.filename,
        url,
        size: options.size,
      };
    } catch (error) {
      getUploadLogger().error("File upload failed", {
        userId: options.userId,
        filename: options.filename,
        error: (error as Error).message,
      });

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get file metadata
   */
  async getFile(fileId: string): Promise<FileMetadataObject | null> {
    const result = await this.kv.get(["uploads", "files", fileId]);
    return result.value as FileMetadataObject | null;
  }

  /**
   * Download file data
   */
  async downloadFile(
    fileId: string,
    userId: string,
  ): Promise<
    {
      data: Uint8Array;
      metadata: FileMetadataObject;
    } | null
  > {
    const metadata = await this.getFile(fileId);
    if (!metadata) return null;

    // Check permissions
    if (metadata.documentPath) {
      const permission = await this.permissionService.resolvePermission(
        userId,
        metadata.documentPath,
      );

      if (
        !this.permissionService.hasPermissionLevel(permission.level, "VIEWER")
      ) {
        throw new Error("Insufficient permissions to download this file");
      }
    } else if (metadata.uploadedBy !== userId) {
      throw new Error("File not found or access denied");
    }

    // Get file data
    const data = await this.storageProvider.retrieve(fileId);

    // Update download count
    await this.kv.set(["uploads", "files", fileId], {
      ...metadata,
      downloadCount: metadata.downloadCount + 1,
    });

    getUploadLogger().info("File downloaded", {
      fileId,
      userId,
      filename: metadata.filename,
    });

    return { data, metadata };
  }

  /**
   * Delete a file
   */
  async deleteFile(fileId: string, userId: string): Promise<boolean> {
    const metadata = await this.getFile(fileId);
    if (!metadata) return false;

    // Check permissions (only uploader or document editor can delete)
    if (metadata.uploadedBy !== userId) {
      if (metadata.documentPath) {
        const permission = await this.permissionService.resolvePermission(
          userId,
          metadata.documentPath,
        );

        if (
          !this.permissionService.hasPermissionLevel(permission.level, "EDITOR")
        ) {
          throw new Error("Insufficient permissions to delete this file");
        }
      } else {
        throw new Error("File not found or access denied");
      }
    }

    try {
      // Delete from storage
      await this.storageProvider.delete(fileId);

      // Delete metadata
      await this.kv.delete(["uploads", "files", fileId]);
      await this.kv.delete(["uploads", "by_user", metadata.uploadedBy, fileId]);

      if (metadata.documentPath) {
        await this.kv.delete([
          "uploads",
          "by_document",
          metadata.documentPath,
          fileId,
        ]);
      }

      getUploadLogger().info("File deleted", {
        fileId,
        userId,
        filename: metadata.filename,
      });

      return true;
    } catch (error) {
      getUploadLogger().error("Failed to delete file", {
        fileId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * List files for a user
   */
  async listUserFiles(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<FileMetadataObject[]> {
    const files: FileMetadataObject[] = [];
    const iter = this.kv.list(
      { prefix: ["uploads", "by_user", userId] },
      {
        limit,
        reverse: true, // Most recent first
      },
    );

    let count = 0;
    for await (const { value } of iter) {
      if (count < offset) {
        count++;
        continue;
      }

      const fileId = value as string;
      const metadata = await this.getFile(fileId);
      if (metadata) {
        files.push(metadata);
      }

      count++;
      if (files.length >= limit) break;
    }

    return files;
  }

  /**
   * List files for a document
   */
  async listDocumentFiles(
    documentPath: string,
    userId: string,
  ): Promise<FileMetadataObject[]> {
    // Check permissions
    const permission = await this.permissionService.resolvePermission(
      userId,
      documentPath,
    );
    if (
      !this.permissionService.hasPermissionLevel(permission.level, "VIEWER")
    ) {
      throw new Error("Insufficient permissions to view document files");
    }

    const files: FileMetadataObject[] = [];
    const iter = this.kv.list({
      prefix: ["uploads", "by_document", documentPath],
    });

    for await (const { value } of iter) {
      const fileId = value as string;
      const metadata = await this.getFile(fileId);
      if (metadata) {
        files.push(metadata);
      }
    }

    return files.sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    );
  }

  /**
   * Get upload statistics
   */
  async getUploadStats(userId?: string): Promise<{
    totalFiles: number;
    totalSize: number;
    filesByType: Record<string, number>;
  }> {
    let totalFiles = 0;
    let totalSize = 0;
    const filesByType: Record<string, number> = {};

    const prefix = userId ? ["uploads", "by_user", userId] : ["uploads", "files"];
    const iter = this.kv.list({ prefix });

    for await (const { value } of iter) {
      if (userId) {
        // For user stats, value is fileId
        const fileId = value as string;
        const metadata = await this.getFile(fileId);
        if (metadata) {
          totalFiles++;
          totalSize += metadata.size;
          filesByType[metadata.mimeType] = (filesByType[metadata.mimeType] || 0) + 1;
        }
      } else {
        // For global stats, value is metadata
        const metadata = value as FileMetadataObject;
        totalFiles++;
        totalSize += metadata.size;
        filesByType[metadata.mimeType] = (filesByType[metadata.mimeType] || 0) + 1;
      }
    }

    return {
      totalFiles,
      totalSize,
      filesByType,
    };
  }

  /**
   * Clean up orphaned files
   */
  async cleanupOrphanedFiles(): Promise<number> {
    let cleaned = 0;
    const iter = this.kv.list({ prefix: ["uploads", "files"] });

    for await (const { key, value } of iter) {
      const metadata = value as FileMetadataObject;
      const fileExists = await this.storageProvider.exists(metadata.id);

      if (!fileExists) {
        // File doesn't exist in storage, clean up metadata
        await this.kv.delete(key);
        await this.kv.delete([
          "uploads",
          "by_user",
          metadata.uploadedBy,
          metadata.id,
        ]);

        if (metadata.documentPath) {
          await this.kv.delete([
            "uploads",
            "by_document",
            metadata.documentPath,
            metadata.id,
          ]);
        }

        cleaned++;
        getUploadLogger().info("Cleaned up orphaned file metadata", {
          fileId: metadata.id,
          filename: metadata.filename,
        });
      }
    }

    getUploadLogger().info("Cleanup completed", { cleanedFiles: cleaned });
    return cleaned;
  }

  /**
   * Validate uploaded file
   */
  private async validateFile(options: UploadOptions): Promise<{
    valid: boolean;
    error?: string;
  }> {
    // Check file size
    if (options.size > this.uploadConfig.maxFileSize) {
      return {
        valid: false,
        error: `File size exceeds maximum allowed size of ${this.uploadConfig.maxFileSize} bytes`,
      };
    }

    // Check MIME type
    if (!this.uploadConfig.allowedMimeTypes.includes(options.mimeType)) {
      return {
        valid: false,
        error: `MIME type ${options.mimeType} is not allowed`,
      };
    }

    // Check file extension
    const extension = this.getFileExtension(options.filename);
    if (!this.uploadConfig.allowedExtensions.includes(extension)) {
      return {
        valid: false,
        error: `File extension ${extension} is not allowed`,
      };
    }

    // Basic security checks
    if (this.containsSuspiciousContent(options.filename)) {
      return {
        valid: false,
        error: "Filename contains suspicious content",
      };
    }

    return { valid: true };
  }

  /**
   * Get file extension from filename
   */
  private getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf(".");
    return lastDot > 0 ? filename.substring(lastDot).toLowerCase() : "";
  }

  /**
   * Check for suspicious content in filename
   */
  private containsSuspiciousContent(filename: string): boolean {
    const suspicious = [
      "../",
      "..\\",
      ".exe",
      ".bat",
      ".cmd",
      ".scr",
      ".vbs",
      ".js",
      ".jar",
      ".com",
      ".pif",
    ];

    const lowerFilename = filename.toLowerCase();
    return suspicious.some((pattern) => lowerFilename.includes(pattern));
  }
}

// Singleton instance
let uploadsService: UploadsService | null = null;

/**
 * Get the global uploads service instance
 */
export function getUploadsService(): UploadsService {
  if (!uploadsService) {
    throw new Error(
      "Uploads service not initialized. Call createUploadsService() first.",
    );
  }
  return uploadsService;
}

/**
 * Create and initialize the global uploads service
 */
export async function createUploadsService(
  kv: Deno.Kv,
  config: ConfigService,
  permissionService: PermissionService,
): Promise<UploadsService> {
  if (uploadsService) {
    return uploadsService;
  }

  uploadsService = new UploadsService(kv, config, permissionService);
  await uploadsService.initialize();
  getUploadLogger().info("Uploads service initialized");
  return uploadsService;
}
