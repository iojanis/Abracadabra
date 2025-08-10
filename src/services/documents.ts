// Document Service for Abracadabra Server
// Manages hierarchical document structure with permission inheritance

import type {
  DocumentDetails,
  DocumentMetadataObject,
  DocumentPermissions,
  PermissionLevel,
  PermissionObject,
  ServerConfig,
} from "../types/index.ts";
import type { ConfigService } from "./config.ts";
import { getLogger } from "./logging.ts";
import * as Y from "yjs";

let logger: ReturnType<typeof getLogger> | null = null;

function getDocumentLogger() {
  if (!logger) {
    logger = getLogger(["documents"]);
  }
  return logger;
}

export interface DocumentCreateOptions {
  title?: string;
  description?: string;
  isPublic?: boolean;
  initialContent?: string;
  permissions?: DocumentPermissions;
}

export interface DocumentUpdateOptions {
  title?: string;
  description?: string;
  isPublic?: boolean;
}

export interface DocumentListOptions {
  includeChildren?: boolean;
  maxDepth?: number;
  onlyDirectChildren?: boolean;
  includePermissions?: boolean;
}

export interface DocumentSearchOptions {
  query?: string;
  includeContent?: boolean;
  maxResults?: number;
  onlyPublic?: boolean;
}

export class DocumentService {
  private kv: Deno.Kv;
  private config: ServerConfig;
  private maxNestingDepth: number;
  private maxDocumentSize: number;

  constructor(kv: Deno.Kv, configService: ConfigService) {
    this.kv = kv;
    // Initialize with defaults, will be updated asynchronously
    this.config = {
      max_nesting_depth: 10,
      max_document_size: 10485760, // 10MB
    } as ServerConfig;
    this.maxNestingDepth = 10;
    this.maxDocumentSize = 10485760;

    // Load config asynchronously
    this.initializeConfig(configService);
  }

  private async initializeConfig(configService: ConfigService) {
    try {
      this.config = (await configService.getServerConfig()) as ServerConfig;
      this.maxNestingDepth = this.config.max_nesting_depth || 10;
      this.maxDocumentSize = this.config.max_document_size || 10485760;
    } catch (error) {
      getDocumentLogger().error(
        "Failed to load configuration, using defaults",
        { error },
      );
    }
  }

  // ============================================================================
  // Path Utilities
  // ============================================================================

  /**
   * Validate and normalize a document path
   */
  validatePath(path: string): {
    valid: boolean;
    error?: string;
    normalized?: string;
  } {
    try {
      // Remove leading/trailing slashes and normalize
      const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");

      if (!normalized) {
        return { valid: false, error: "Path cannot be empty" };
      }

      // Split into components
      const components = normalized.split("/");

      if (components.length < 1) {
        return { valid: false, error: "Path must contain at least a username" };
      }

      // Check nesting depth
      if (components.length > this.maxNestingDepth + 1) {
        // +1 for username
        return {
          valid: false,
          error: `Path exceeds maximum nesting depth of ${this.maxNestingDepth}`,
        };
      }

      // Validate username (first component)
      const username = components[0];
      if (!/^[a-zA-Z0-9_-]{1,50}$/.test(username)) {
        return {
          valid: false,
          error:
            "Username must be 1-50 characters and contain only letters, numbers, underscores, and hyphens",
        };
      }

      // Validate path components
      for (let i = 1; i < components.length; i++) {
        const component = components[i];
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(component)) {
          return {
            valid: false,
            error: `Path component "${component}" must be 1-100 characters and contain only letters, numbers, underscores, and hyphens`,
          };
        }
      }

      return { valid: true, normalized: `/${normalized}` };
    } catch (error) {
      getDocumentLogger().error("Error validating path", {
        path,
        error: (error as Error).message,
      });
      return { valid: false, error: "Invalid path format" };
    }
  }

  /**
   * Extract username from path
   */
  extractUsername(path: string): string | null {
    const validation = this.validatePath(path);
    if (!validation.valid || !validation.normalized) return null;

    const components = validation.normalized.substring(1).split("/");
    return components[0] || null;
  }

  /**
   * Get parent path of a document
   */
  getParentPath(path: string): string | null {
    const validation = this.validatePath(path);
    if (!validation.valid || !validation.normalized) return null;

    const components = validation.normalized.substring(1).split("/");
    if (components.length <= 1) return null; // Username level has no parent

    return `/${components.slice(0, -1).join("/")}`;
  }

  /**
   * Get all ancestor paths (for permission inheritance)
   */
  getAncestorPaths(path: string): string[] {
    const ancestors: string[] = [];
    let currentPath = path;

    while (true) {
      const parent = this.getParentPath(currentPath);
      if (!parent) break;
      ancestors.unshift(parent);
      currentPath = parent;
    }

    return ancestors;
  }

  // ============================================================================
  // Document CRUD Operations
  // ============================================================================

  /**
   * Create a new document
   */
  async createDocument(
    path: string,
    creatorId: string,
    options: DocumentCreateOptions = {},
  ): Promise<DocumentDetails> {
    const validation = this.validatePath(path);
    if (!validation.valid) {
      throw new Error(`Invalid path: ${validation.error}`);
    }

    const normalizedPath = validation.normalized!;

    getDocumentLogger().debug("Creating document", {
      path: normalizedPath,
      creatorId,
    });

    // Check if document already exists
    const existing = await this.getDocumentMetadata(normalizedPath);
    if (existing) {
      throw new Error(`Document already exists at path: ${normalizedPath}`);
    }

    // Create Yjs document
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    if (options.initialContent) {
      ytext.insert(0, options.initialContent);
    }

    const now = Date.now();
    const documentId = crypto.randomUUID();

    // Create default permissions first
    const permissions: DocumentPermissions = options.permissions || {
      owner: creatorId,
      editors: [],
      viewers: [],
      commenters: [],
      inheritFromParent: true,
      inherit_from_parent: true,
      publicAccess: options.isPublic ? "VIEWER" : "NONE",
      public_access: options.isPublic ? "VIEWER" : "NONE",
    };

    // Create document metadata
    const docParentPath = this.getParentPath(normalizedPath);
    const metadata: DocumentMetadataObject = {
      id: documentId,
      name: normalizedPath.split("/").pop() || "Untitled",
      path: normalizedPath,
      fullPath: normalizedPath,
      ownerId: creatorId,
      ...(docParentPath ? { parentPath: docParentPath } : {}),
      depth: normalizedPath.split("/").length - 1,
      title: options.title || normalizedPath.split("/").pop() || "Untitled",
      description: options.description || "",
      tags: [],
      size: Y.encodeStateAsUpdate(ydoc).length,
      version: 1,
      is_public: options.isPublic || false,
      isArchived: false,
      collaborator_count: 0,
      permissions,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      updated_at: now,
      lastAccessedAt: new Date(now),
      last_accessed_at: now,
    };

    // Store in KV
    const batch = this.kv.atomic();

    // Store metadata
    batch.set(["documents", "metadata", normalizedPath], metadata);

    // Store permissions
    batch.set(["documents", "permissions", normalizedPath], permissions);

    // Store Yjs state
    batch.set(
      ["documents", "yjs_state", normalizedPath],
      Y.encodeStateAsUpdate(ydoc),
    );

    // Update parent's children list if this isn't a root document
    const docParentPath2 = this.getParentPath(normalizedPath);
    if (docParentPath2) {
      const parentChildren = await this.kv.get([
        "documents",
        "children",
        docParentPath2,
      ]);
      const children = (parentChildren.value as string[]) || [];
      children.push(normalizedPath);
      batch.set(["documents", "children", docParentPath2], children);
    }

    // Add to owner's document list
    const username = this.extractUsername(normalizedPath);
    if (username) {
      const userDocs = await this.kv.get(["documents", "by_user", username]);
      const docs = (userDocs.value as string[]) || [];
      docs.push(normalizedPath);
      batch.set(["documents", "by_user", username], docs);
    }

    const result = await batch.commit();
    if (!result.ok) {
      throw new Error("Failed to create document");
    }

    getDocumentLogger().info("Document created successfully", {
      path: normalizedPath,
      documentId,
      creatorId,
    });

    return {
      metadata,
      permissions,
      children: [],
      title: metadata.title,
      description: metadata.description || "",
      tags: metadata.tags,
      fileSize: metadata.size,
      size: metadata.size,
      wordCount: 0,
      version: metadata.version,
      isPublic: metadata.is_public,
      isArchived: metadata.isArchived,
      collaboratorCount: metadata.collaborator_count,
      collaborator_count: metadata.collaborator_count,
      updated_at: metadata.updated_at,
    };
  }

  /**
   * Get document metadata only
   */
  async getDocumentMetadata(
    path: string,
  ): Promise<DocumentMetadataObject | null> {
    const validation = this.validatePath(path);
    if (!validation.valid) return null;

    const result = await this.kv.get([
      "documents",
      "metadata",
      validation.normalized!,
    ]);
    return result.value as DocumentMetadataObject | null;
  }

  /**
   * Get full document details
   */
  async getDocument(
    path: string,
    options: DocumentListOptions = {},
  ): Promise<DocumentDetails | null> {
    const validation = this.validatePath(path);
    if (!validation.valid) return null;

    const normalizedPath = validation.normalized!;

    getDocumentLogger().debug("Retrieving document", { path: normalizedPath });

    // Get all document data in parallel
    const [metadataResult, permissionsResult, yjsStateResult, childrenResult] =
      await Promise.all([
        this.kv.get(["documents", "metadata", normalizedPath]),
        options.includePermissions
          ? this.kv.get(["documents", "permissions", normalizedPath])
          : null,
        this.kv.get(["documents", "yjs_state", normalizedPath]),
        options.includeChildren
          ? this.kv.get(["documents", "children", normalizedPath])
          : null,
      ]);

    const metadata = metadataResult.value as DocumentMetadataObject | null;
    if (!metadata) return null;

    // Update last accessed time
    metadata.lastAccessedAt = new Date();
    metadata.last_accessed_at = Date.now();
    await this.kv.set(["documents", "metadata", normalizedPath], metadata);

    const permissions = permissionsResult?.value as
      | DocumentPermissions
      | undefined;
    const yjsState = yjsStateResult.value as Uint8Array | null;
    const childrenPaths = childrenResult?.value as string[] | undefined;

    let children: string[] = [];
    if (options.includeChildren && childrenPaths) {
      if (options.onlyDirectChildren) {
        children = childrenPaths;
      } else if (options.maxDepth) {
        // TODO: Implement recursive children fetching with depth limit
        children = childrenPaths;
      } else {
        children = childrenPaths;
      }
    }

    return {
      metadata,
      permissions: permissions || {
        inheritFromParent: true,
        inherit_from_parent: true,
        publicAccess: "NONE",
        public_access: "NONE",
        owner: metadata.ownerId,
        editors: [],
        commenters: [],
        viewers: [],
      },
      children: childrenPaths || [],
      title: metadata.title,
      description: metadata.description || "",
      tags: metadata.tags,
      fileSize: metadata.size,
      size: metadata.size,
      wordCount: 0,
      version: metadata.version,
      isPublic: metadata.is_public,
      isArchived: metadata.isArchived,
      collaboratorCount: metadata.collaborator_count,
      collaborator_count: metadata.collaborator_count,
      updated_at: metadata.updated_at,
    };
  }

  /**
   * Update document metadata
   */
  async updateDocument(
    path: string,
    userId: string,
    options: DocumentUpdateOptions,
  ): Promise<DocumentMetadataObject | null> {
    const validation = this.validatePath(path);
    if (!validation.valid) {
      throw new Error(`Invalid path: ${validation.error}`);
    }

    const normalizedPath = validation.normalized!;

    getDocumentLogger().info("Updating document", {
      path: normalizedPath,
      userId,
    });

    const existing = await this.getDocumentMetadata(normalizedPath);
    if (!existing) {
      throw new Error(`Document not found: ${normalizedPath}`);
    }

    const updated: DocumentMetadataObject = {
      ...existing,
      ...options,
      updatedAt: new Date(),
      updated_at: Date.now(),
      version: existing.version + 1,
    };

    await this.kv.set(["documents", "metadata", normalizedPath], updated);

    getDocumentLogger().info("Document updated successfully", {
      path: normalizedPath,
      userId,
      version: updated.version,
    });

    return updated;
  }

  /**
   * Delete a document and all its children
   */
  async deleteDocument(path: string, userId: string): Promise<boolean> {
    const validation = this.validatePath(path);
    if (!validation.valid) {
      throw new Error(`Invalid path: ${validation.error}`);
    }

    const normalizedPath = validation.normalized!;

    getDocumentLogger().info("Deleting document", {
      path: normalizedPath,
      userId,
    });

    const document = await this.getDocument(normalizedPath, {
      includeChildren: true,
    });
    if (!document) {
      return false; // Document doesn't exist
    }

    // Recursively delete children first
    // Check if document has children
    if (document.children && document.children.length > 0) {
      for (const childPath of document.children) {
        await this.deleteDocument(childPath, userId);
      }
    }

    // Delete the document itself
    const batch = this.kv.atomic();
    batch.delete(["documents", "metadata", normalizedPath]);
    batch.delete(["documents", "permissions", normalizedPath]);
    batch.delete(["documents", "yjs_state", normalizedPath]);
    batch.delete(["documents", "children", normalizedPath]);

    // Remove from parent's children list
    const parentPath = this.getParentPath(normalizedPath);
    if (parentPath) {
      const parentChildren = await this.kv.get([
        "documents",
        "children",
        parentPath,
      ]);
      const children = (parentChildren.value as string[]) || [];
      const updatedChildren = children.filter(
        (child) => child !== normalizedPath,
      );
      if (updatedChildren.length > 0) {
        batch.set(["documents", "children", parentPath], updatedChildren);
      } else {
        batch.delete(["documents", "children", parentPath]);
      }
    }

    // Remove from user's document list
    const username = this.extractUsername(normalizedPath);
    if (username) {
      const userDocs = await this.kv.get(["documents", "by_user", username]);
      const docs = (userDocs.value as string[]) || [];
      const updatedDocs = docs.filter((doc) => doc !== normalizedPath);
      if (updatedDocs.length > 0) {
        batch.set(["documents", "by_user", username], updatedDocs);
      } else {
        batch.delete(["documents", "by_user", username]);
      }
    }

    const result = await batch.commit();
    if (!result.ok) {
      throw new Error("Failed to delete document");
    }

    getDocumentLogger().info("Document deleted successfully", {
      path: normalizedPath,
      userId,
    });

    return true;
  }

  // ============================================================================
  // Yjs Document Management
  // ============================================================================

  /**
   * Update Yjs document state
   */
  async updateYjsDocument(path: string, update: Uint8Array): Promise<boolean> {
    const validation = this.validatePath(path);
    if (!validation.valid) return false;

    const normalizedPath = validation.normalized!;

    // Get current state
    const currentState = await this.kv.get([
      "documents",
      "yjs_state",
      normalizedPath,
    ]);

    // Apply update
    const ydoc = new Y.Doc();
    if (currentState.value) {
      Y.applyUpdate(ydoc, currentState.value as Uint8Array);
    }
    Y.applyUpdate(ydoc, update);

    // Check size limit
    const newState = Y.encodeStateAsUpdate(ydoc);
    if (newState.length > this.maxDocumentSize) {
      getDocumentLogger().warn("Document size exceeds limit", {
        path: normalizedPath,
        size: newState.length,
        limit: this.maxDocumentSize,
      });
      return false;
    }

    // Store updated state and update metadata
    const batch = this.kv.atomic();
    batch.set(["documents", "yjs_state", normalizedPath], newState);

    // Update document metadata
    const metadata = await this.getDocumentMetadata(normalizedPath);
    if (metadata) {
      metadata.updated_at = Date.now();
      metadata.size = newState.length;
      metadata.version = metadata.version + 1;
      batch.set(["documents", "metadata", normalizedPath], metadata);
    }

    const result = await batch.commit();
    return result.ok;
  }

  /**
   * Get Yjs document state
   */
  async getYjsDocument(path: string): Promise<Uint8Array | null> {
    const validation = this.validatePath(path);
    if (!validation.valid) return null;

    const result = await this.kv.get([
      "documents",
      "yjs_state",
      validation.normalized!,
    ]);
    return result.value as Uint8Array | null;
  }

  // ============================================================================
  // Document Listing and Search
  // ============================================================================

  /**
   * List documents for a user
   */
  async listUserDocuments(
    username: string,
    options: DocumentListOptions = {},
  ): Promise<DocumentMetadataObject[]> {
    getDocumentLogger().debug("Listing user documents", { username });

    const userDocsResult = await this.kv.get([
      "documents",
      "by_user",
      username,
    ]);
    const docPaths = (userDocsResult.value as string[]) || [];

    const documents: DocumentMetadataObject[] = [];

    for (const path of docPaths) {
      const metadata = await this.getDocumentMetadata(path);
      if (metadata) {
        documents.push(metadata);
      }
    }

    // Sort by updated_at descending
    documents.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    return documents;
  }

  /**
   * List children of a document
   */
  async listChildren(
    path: string,
    options: DocumentListOptions = {},
  ): Promise<DocumentMetadataObject[]> {
    const validation = this.validatePath(path);
    if (!validation.valid) return [];

    const normalizedPath = validation.normalized!;
    const childrenResult = await this.kv.get([
      "documents",
      "children",
      normalizedPath,
    ]);
    const childPaths = (childrenResult.value as string[]) || [];

    const children: DocumentMetadataObject[] = [];

    for (const childPath of childPaths) {
      const metadata = await this.getDocumentMetadata(childPath);
      if (metadata) {
        children.push(metadata);
      }
    }

    // Sort by title
    children.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    return children;
  }

  /**
   * Search documents
   */
  async searchDocuments(
    query: string,
    userId?: string,
    options: DocumentSearchOptions = {},
  ): Promise<DocumentMetadataObject[]> {
    getDocumentLogger().debug("Searching documents", { query, userId });

    const results: DocumentMetadataObject[] = [];
    const maxResults = options.maxResults || 50;

    // Simple implementation: iterate through all documents
    // In production, you'd want to use a proper search index
    const iter = this.kv.list({ prefix: ["documents", "metadata"] });

    for await (const entry of iter) {
      if (results.length >= maxResults) break;

      const metadata = entry.value as DocumentMetadataObject;

      // Apply filters
      if (options.onlyPublic && !metadata.is_public) continue;

      // Simple text matching
      const searchText =
        `${metadata.title || ""} ${metadata.description || ""}`.toLowerCase();
      if (searchText.includes(query.toLowerCase())) {
        results.push(metadata);
      }
    }

    // Sort by relevance (for now, just by updated_at)
    results.sort((a, b) => b.updated_at - a.updated_at);

    return results;
  }

  // ============================================================================
  // Statistics and Utilities
  // ============================================================================

  /**
   * Get document statistics
   */
  async getDocumentStats(path?: string): Promise<{
    totalDocuments: number;
    totalSize: number;
    lastUpdated: number;
    activeCollaborators: number;
  }> {
    if (path) {
      // Stats for specific document and its children
      const document = await this.getDocument(path, { includeChildren: true });
      if (!document) {
        return {
          totalDocuments: 0,
          totalSize: 0,
          lastUpdated: 0,
          activeCollaborators: 0,
        };
      }

      // Count this document plus all children recursively
      let totalDocs = 1;
      let totalSize = document.metadata.size || 0;
      let lastUpdated = document.metadata.updated_at || 0;
      let activeCollaborators = document.metadata.collaborator_count || 0;

      if (document.children && document.children.length > 0) {
        for (const childPath of document.children) {
          const childStats = await this.getDocumentStats(childPath);
          totalDocs += childStats.totalDocuments;
          totalSize += childStats.totalSize;
          lastUpdated = Math.max(lastUpdated, childStats.lastUpdated);
          activeCollaborators += childStats.activeCollaborators;
        }
      }

      return {
        totalDocuments: totalDocs,
        totalSize,
        lastUpdated,
        activeCollaborators,
      };
    } else {
      // Global stats
      let totalDocuments = 0;
      let totalSize = 0;
      let lastUpdated = 0;
      let activeCollaborators = 0;

      const iter = this.kv.list({ prefix: ["documents", "metadata"] });
      for await (const entry of iter) {
        const metadata = entry.value as DocumentMetadataObject;
        totalDocuments++;
        totalSize += metadata.size || 0;
        lastUpdated = Math.max(lastUpdated, metadata.updated_at || 0);
        activeCollaborators += metadata.collaborator_count || 0;
      }

      return { totalDocuments, totalSize, lastUpdated, activeCollaborators };
    }
  }

  /**
   * Cleanup orphaned documents
   */
  async cleanup(): Promise<{ cleaned: number; errors: string[] }> {
    getDocumentLogger().info("Starting document cleanup");

    let cleaned = 0;
    const errors: string[] = [];

    // TODO: Implement cleanup logic
    // - Remove documents with invalid paths
    // - Clean up orphaned children references
    // - Remove documents from deleted users

    getDocumentLogger().info("Document cleanup completed", {
      cleaned,
      errors: errors.length,
    });

    return { cleaned, errors };
  }

  /**
   * Cleanup old or orphaned documents
   */
  async cleanupDocuments(): Promise<{
    documentsRemoved: number;
    storageFreed: number;
  }> {
    getDocumentLogger().info("Starting document cleanup operation");

    let documentsRemoved = 0;
    let storageFreed = 0;

    try {
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      // Get all document metadata
      const documentsIter = this.kv.list({ prefix: ["documents", "metadata"] });

      for await (const entry of documentsIter) {
        const metadata = entry.value as DocumentMetadataObject;

        // Check if document is old and inactive
        if (metadata.lastAccessedAt < cutoffDate && metadata.isArchived) {
          const path = metadata.path;

          // Get document size before deletion
          const stateResult = await this.kv.get([
            "documents",
            "yjs_state",
            path,
          ]);
          if (stateResult.value) {
            const state = stateResult.value as Uint8Array;
            storageFreed += state.length;
          }

          // Delete document and related data
          const batch = this.kv.atomic();
          batch.delete(["documents", "metadata", path]);
          batch.delete(["documents", "yjs_state", path]);
          batch.delete(["documents", "children", path]);
          batch.delete(["documents", "permissions", path]);

          const result = await batch.commit();
          if (result.ok) {
            documentsRemoved++;
            getDocumentLogger().debug("Cleaned up document", { path });
          }
        }
      }

      getDocumentLogger().info("Document cleanup completed", {
        documentsRemoved,
        storageFreed,
      });

      return { documentsRemoved, storageFreed };
    } catch (error) {
      getDocumentLogger().error("Error during document cleanup", {
        error: (error as Error).message,
      });
      return { documentsRemoved, storageFreed };
    }
  }
}

/**
 * Create document service instance
 */
export async function createDocumentService(
  kv: Deno.Kv,
  configService: ConfigService,
): Promise<DocumentService> {
  const service = new DocumentService(kv, configService);

  getDocumentLogger().info("Document service initialized");
  return service;
}

/**
 * Document path utilities (exported for use in other services)
 */
export const DocumentPathUtils = {
  validate: (path: string, maxDepth = 10) => {
    const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
    if (!normalized) return { valid: false, error: "Path cannot be empty" };

    const components = normalized.split("/");
    if (components.length > maxDepth + 1) {
      return {
        valid: false,
        error: `Path exceeds maximum depth of ${maxDepth}`,
      };
    }

    for (const component of components) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(component)) {
        return { valid: false, error: `Invalid component: ${component}` };
      }
    }

    return { valid: true, normalized: `/${normalized}` };
  },

  extractUsername: (path: string) => {
    const components = path.replace(/^\/+|\/+$/g, "").split("/");
    return components[0] || null;
  },

  getParent: (path: string) => {
    const components = path.replace(/^\/+|\/+$/g, "").split("/");
    if (components.length <= 1) return null;
    return `/${components.slice(0, -1).join("/")}`;
  },
};
