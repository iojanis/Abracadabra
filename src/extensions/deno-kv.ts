// Deno KV Extension for Hocuspocus
// Handles real-time document persistence using Deno KV

import type {
  Extension,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
  onChangePayload,
  onDestroyPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";
import { getLogger } from "../services/logging.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getDenoKvLogger() {
  if (!logger) {
    logger = getLogger(["deno-kv-extension"]);
  }
  return logger;
}

export interface DenoKvExtensionConfig {
  debounceInterval?: number;
  maxRetries?: number;
  retryDelay?: number;
  enableMetrics?: boolean;
}

export class DenoKvExtension implements Extension {
  private kv: Deno.Kv;
  private config: DenoKvExtensionConfig;
  private saveTimeouts = new Map<string, number>();
  private metrics = {
    documentsLoaded: 0,
    documentsSaved: 0,
    saveErrors: 0,
    loadErrors: 0,
  };

  constructor(kv: Deno.Kv, config: DenoKvExtensionConfig = {}) {
    this.kv = kv;
    this.config = {
      debounceInterval: 2000, // 2 second debounce for saves
      maxRetries: 3,
      retryDelay: 1000,
      enableMetrics: true,
      ...config,
    };

    getDenoKvLogger().info("Deno KV extension initialized", {
      debounceInterval: this.config.debounceInterval,
      maxRetries: this.config.maxRetries,
    });
  }

  // ============================================================================
  // Extension Lifecycle Methods
  // ============================================================================

  /**
   * Load document state from Deno KV
   */
  async onLoadDocument(payload: onLoadDocumentPayload): Promise<Y.Doc | null> {
    const { documentName } = payload;

    getDenoKvLogger().debug("Loading document from KV", { documentName });

    try {
      // Get document state from KV
      const result = await this.kv.get([
        "documents",
        "yjs_state",
        documentName,
      ]);

      if (!result.value) {
        getDenoKvLogger().debug(
          "Document not found in KV, creating new document",
          {
            documentName,
          },
        );

        // Create new document
        const ydoc = new Y.Doc();

        // Initialize with empty text content
        const ytext = ydoc.getText("content");

        if (this.config.enableMetrics) {
          this.metrics.documentsLoaded++;
        }

        return ydoc;
      }

      // Restore document from stored state
      const state = result.value as Uint8Array;
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, state);

      // Update last accessed time
      await this.updateDocumentMetadata(documentName, {
        last_accessed_at: Date.now(),
      });

      if (this.config.enableMetrics) {
        this.metrics.documentsLoaded++;
      }

      getDenoKvLogger().debug("Document loaded successfully from KV", {
        documentName,
        stateSize: state.length,
      });

      return ydoc;
    } catch (error) {
      this.metrics.saveErrors++;
      getDenoKvLogger().error("Failed to store document to KV", {
        documentName,
        error: (error as Error).message,
      });

      if (this.config.enableMetrics) {
        this.metrics.loadErrors++;
      }

      // Return null to let Hocuspocus create a new document
      return null;
    }
  }

  /**
   * Store document state to Deno KV (with debouncing)
   */
  async onStoreDocument(payload: onStoreDocumentPayload): Promise<void> {
    const { documentName, document } = payload;

    getDenoKvLogger().debug("Storing document to KV", { documentName });

    // Clear existing timeout for this document
    const existingTimeout = this.saveTimeouts.get(documentName);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set up debounced save
    const timeout = setTimeout(async () => {
      await this.saveDocumentToKv(documentName, document);
      this.saveTimeouts.delete(documentName);
    }, this.config.debounceInterval);

    this.saveTimeouts.set(documentName, timeout);
  }

  /**
   * Handle document changes
   */
  async onChange(payload: onChangePayload): Promise<void> {
    const { documentName, document } = payload;

    getDenoKvLogger().debug("Document changed", {
      documentName,
      size: Y.encodeStateAsUpdate(document).length,
    });

    // Update document metadata
    await this.updateDocumentMetadata(documentName, {
      updated_at: Date.now(),
      size: Y.encodeStateAsUpdate(document).length,
    });

    // Store document directly instead of using onStoreDocument callback
    try {
      const state = Y.encodeStateAsUpdate(document);
      await this.kv.set(["documents", "yjs_state", documentName], state);

      getDenoKvLogger().debug("Document stored via onChange", {
        documentName,
        size: state.length,
      });
    } catch (error) {
      getDenoKvLogger().error("Failed to store document in onChange", {
        documentName,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Cleanup when extension is destroyed
   */
  async onDestroy(payload: onDestroyPayload): Promise<void> {
    getDenoKvLogger().info("Cleaning up Deno KV extension");

    // Clear all pending save timeouts
    for (const [documentName, timeout] of this.saveTimeouts.entries()) {
      clearTimeout(timeout);

      // Force immediate save for pending documents
      try {
        const result = await this.kv.get([
          "documents",
          "yjs_state",
          documentName,
        ]);
        if (result.value) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, result.value as Uint8Array);
          await this.saveDocumentToKv(documentName, ydoc);
        }
      } catch (error) {
        getDenoKvLogger().error("Failed to save document during cleanup", {
          documentName,
          error: (error as Error).message,
        });
      }
    }

    this.saveTimeouts.clear();

    if (this.config.enableMetrics) {
      getDenoKvLogger().info("Deno KV extension metrics", this.metrics);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Actually save document to KV with retry logic
   */
  private async saveDocumentToKv(
    documentName: string,
    document: Y.Doc,
  ): Promise<void> {
    let retries = 0;
    const maxRetries = this.config.maxRetries!;

    while (retries <= maxRetries) {
      try {
        // Encode document state
        const state = Y.encodeStateAsUpdate(document);

        // Save to KV using atomic transaction
        const batch = this.kv.atomic();

        // Store document state
        batch.set(["documents", "yjs_state", documentName], state);

        // Update document metadata
        const now = Date.now();
        const metadataResult = await this.kv.get([
          "documents",
          "metadata",
          documentName,
        ]);

        if (metadataResult.value) {
          const metadata = metadataResult.value as any;
          const updatedMetadata = {
            ...metadata,
            updated_at: now,
            size: state.length,
            version: (metadata.version || 1) + 1,
          };
          batch.set(["documents", "metadata", documentName], updatedMetadata);
        }

        // Commit transaction
        const result = await batch.commit();

        if (!result.ok) {
          throw new Error("KV transaction failed");
        }

        if (this.config.enableMetrics) {
          this.metrics.documentsSaved++;
        }

        getDenoKvLogger().debug("Document saved successfully to KV", {
          documentName,
          stateSize: state.length,
          retries,
        });

        return;
      } catch (error) {
        retries++;

        getDenoKvLogger().warn("Failed to save document to KV", {
          documentName,
          error: (error as Error).message,
          retries,
          maxRetries,
        });

        if (retries > maxRetries) {
          getDenoKvLogger().error(
            "Max retries exceeded, giving up on document save",
            {
              documentName,
              error: (error as Error).message,
            },
          );

          if (this.config.enableMetrics) {
            this.metrics.saveErrors++;
          }

          throw error;
        }

        // Wait before retry
        await this.sleep(this.config.retryDelay! * retries);
      }
    }
  }

  /**
   * Update document metadata
   */
  private async updateDocumentMetadata(
    documentName: string,
    updates: Record<string, any>,
  ): Promise<void> {
    try {
      const result = await this.kv.get(["documents", "metadata", documentName]);

      if (result.value) {
        const metadata = result.value as any;
        const updatedMetadata = { ...metadata, ...updates };
        await this.kv.set(
          ["documents", "metadata", documentName],
          updatedMetadata,
        );
      }
    } catch (error) {
      getDenoKvLogger().warn("Failed to update document metadata", {
        documentName,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================================
  // Public Utility Methods
  // ============================================================================

  /**
   * Get extension metrics
   */
  getMetrics() {
    if (!this.config.enableMetrics) {
      return null;
    }

    return {
      ...this.metrics,
      pendingSaves: this.saveTimeouts.size,
    };
  }

  /**
   * Force save all pending documents
   */
  async flushPendingSaves(): Promise<void> {
    getDenoKvLogger().info("Flushing pending document saves", {
      pendingCount: this.saveTimeouts.size,
    });

    const promises: Promise<void>[] = [];

    for (const [documentName, timeout] of this.saveTimeouts.entries()) {
      clearTimeout(timeout);

      // Create promise to save document
      const promise = (async () => {
        try {
          const result = await this.kv.get([
            "documents",
            "yjs_state",
            documentName,
          ]);
          if (result.value) {
            const ydoc = new Y.Doc();
            Y.applyUpdate(ydoc, result.value as Uint8Array);
            await this.saveDocumentToKv(documentName, ydoc);
          }
        } catch (error) {
          getDenoKvLogger().error("Failed to flush document save", {
            documentName,
            error: (error as Error).message,
          });
        }
      })();

      promises.push(promise);
    }

    this.saveTimeouts.clear();

    // Wait for all saves to complete
    await Promise.allSettled(promises);

    getDenoKvLogger().info("Finished flushing pending document saves");
  }

  /**
   * Get document from KV directly
   */
  async getDocument(documentName: string): Promise<Y.Doc | null> {
    try {
      const result = await this.kv.get([
        "documents",
        "yjs_state",
        documentName,
      ]);

      if (!result.value) {
        return null;
      }

      const state = result.value as Uint8Array;
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, state);

      return ydoc;
    } catch (error) {
      getDenoKvLogger().error("Failed to load document from KV", {
        documentName,
        error: (error as Error).message,
      });
      this.metrics.loadErrors++;
      return null;
    }
  }

  /**
   * Check if document exists in KV
   */
  async hasDocument(documentName: string): Promise<boolean> {
    try {
      const result = await this.kv.get([
        "documents",
        "yjs_state",
        documentName,
      ]);
      return result.value !== null;
    } catch (error) {
      getDenoKvLogger().error("Failed to check document existence", {
        documentName,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Delete document from KV
   */
  async deleteDocument(documentName: string): Promise<boolean> {
    try {
      const batch = this.kv.atomic();
      batch.delete(["documents", "yjs_state", documentName]);

      const result = await batch.commit();

      if (result.ok) {
        getDenoKvLogger().info("Document deleted from KV", { documentName });
        return true;
      } else {
        getDenoKvLogger().warn("Failed to delete document from KV", {
          documentName,
        });
        return false;
      }
    } catch (error) {
      getDenoKvLogger().error("Error deleting document from KV", {
        documentName,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    totalDocuments: number;
    totalSize: number;
  }> {
    let totalDocuments = 0;
    let totalSize = 0;

    try {
      const iter = this.kv.list({ prefix: ["documents", "yjs_state"] });

      for await (const entry of iter) {
        totalDocuments++;
        const state = entry.value as Uint8Array;
        totalSize += state.length;
      }
    } catch (error) {
      getDenoKvLogger().error("Failed to get storage stats", {
        error: (error as Error).message,
      });
    }

    return { totalDocuments, totalSize };
  }
}

/**
 * Create Deno KV extension for Hocuspocus
 */
export function createDenoKvExtension(
  kv: Deno.Kv,
  config?: DenoKvExtensionConfig,
): DenoKvExtension {
  return new DenoKvExtension(kv, config);
}
