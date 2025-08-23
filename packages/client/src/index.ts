import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebrtcProvider } from "y-webrtc";
import { HocuspocusProvider } from "@hocuspocus/provider";

/**
 * Authentication data structure
 */
export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  settings: Record<string, any>;
}

/**
 * Document metadata structure
 */
export interface DocumentMetadata {
  id: string;
  path: string;
  title?: string;
  description?: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  isPublic: boolean;
  size: number;
  tags: string[];
  version: number;
  permissions: DocumentPermissions;
}

/**
 * Document permissions structure
 */
export interface DocumentPermissions {
  inheritFromParent: boolean;
  publicAccess: PermissionLevel;
  editors: string[];
  commenters: string[];
  viewers: string[];
}

/**
 * Permission levels
 */
export type PermissionLevel =
  | "NONE"
  | "VIEWER"
  | "COMMENTER"
  | "EDITOR"
  | "ADMIN"
  | "OWNER";

/**
 * File upload metadata
 */
export interface FileMetadata {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploaderId: string;
  documentPath?: string;
  description?: string;
  tags: string[];
  createdAt: string;
  url?: string;
}

/**
 * API Response wrapper
 */
export interface ApiResponse<T = any> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Configuration options for the AbracadabraClient.
 */
export interface AbracadabraClientConfig {
  /**
   * The URL of the Hocuspocus WebSocket server.
   * e.g. 'ws://localhost:8787'
   */
  hocuspocusUrl: string;

  /**
   * The URL of the Abracadabra REST API server.
   * e.g. 'http://localhost:8787'
   */
  serverUrl: string;

  /**
   * The name of the room or document. This is used for all providers.
   */
  roomName: string;

  /**
   * A JWT token for authentication (optional, will be managed automatically)
   */
  token?: string;

  /**
   * Enable WebRTC for peer-to-peer collaboration
   */
  enableWebRTC?: boolean;

  /**
   * Enable offline persistence
   */
  enableOffline?: boolean;

  /**
   * Auto-reconnect on connection loss
   */
  autoReconnect?: boolean;
}

/**
 * Storage interface for persistent token storage
 */
interface TokenStorage {
  getToken(): string | null;
  setToken(token: string): void;
  removeToken(): void;
}

/**
 * Default localStorage-based token storage
 */
class LocalStorageTokenStorage implements TokenStorage {
  private readonly key = "abracadabra_auth_token";

  getToken(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(this.key);
  }

  setToken(token: string): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(this.key, token);
  }

  removeToken(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(this.key);
  }
}

/**
 * Client events
 */
export interface ClientEvents {
  "auth:login": (user: AuthUser) => void;
  "auth:logout": () => void;
  "auth:error": (error: Error) => void;
  "connection:open": () => void;
  "connection:close": () => void;
  "connection:error": (error: Error) => void;
  "document:loaded": (path: string, doc: Y.Doc) => void;
  "document:error": (path: string, error: Error) => void;
  "sync:start": () => void;
  "sync:complete": () => void;
  offline: () => void;
  online: () => void;
  [key: string]: (...args: any[]) => void;
}

/**
 * Event emitter for client events
 */
class EventEmitter<T extends Record<string, (...args: any[]) => void>> {
  private listeners: { [K in keyof T]?: T[K][] } = {};

  on<K extends keyof T>(event: K, listener: T[K]): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(listener);
  }

  off<K extends keyof T>(event: K, listener: T[K]): void {
    if (!this.listeners[event]) return;
    const index = this.listeners[event]!.indexOf(listener);
    if (index >= 0) {
      this.listeners[event]!.splice(index, 1);
    }
  }

  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    if (!this.listeners[event]) return;
    this.listeners[event]!.forEach((listener) => {
      try {
        (listener as any)(...args);
      } catch (error) {
        console.error(`Error in event listener for ${String(event)}:`, error);
      }
    });
  }
}

/**
 * The main client for interacting with the Abracadabra server.
 */
export class AbracadabraClient extends EventEmitter<ClientEvents> {
  public doc: Y.Doc;
  private config: AbracadabraClientConfig;
  private tokenStorage: TokenStorage;

  private indexeddb: IndexeddbPersistence | null = null;
  private webrtc: WebrtcProvider | null = null;
  private hocuspocus: HocuspocusProvider | null = null;

  private subdocs = new Map<string, Y.Doc>();
  private documents: Y.Map<Y.Doc>;
  private documentIndex: Y.Map<DocumentMetadata>;

  private currentUser: AuthUser | null = null;
  private isOnline: boolean = true;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(config: AbracadabraClientConfig) {
    super();
    this.config = {
      enableWebRTC: false,
      enableOffline: true,
      autoReconnect: true,
      ...config,
    };

    this.tokenStorage = new LocalStorageTokenStorage();

    // Initialize Yjs document
    this.doc = new Y.Doc();
    this.documents = this.doc.getMap("documents");
    this.documentIndex = this.doc.getMap("documentIndex");

    // Load existing token if available
    if (!this.config.token) {
      this.config.token = this.tokenStorage.getToken() || undefined;
    }

    // Setup network status monitoring
    this.setupNetworkMonitoring();
  }

  /**
   * Initialize providers and connect to the server
   */
  public async connect(): Promise<void> {
    try {
      // Setup IndexedDB persistence for offline support
      if (this.config.enableOffline && typeof window !== "undefined") {
        this.indexeddb = new IndexeddbPersistence(
          this.config.roomName,
          this.doc,
        );
        await new Promise<void>((resolve) => {
          this.indexeddb!.on("synced", () => resolve());
        });
      }

      // Setup Hocuspocus provider for server sync
      this.hocuspocus = new HocuspocusProvider({
        url: this.config.hocuspocusUrl,
        name: this.config.roomName,
        document: this.doc,
        token: this.config.token,
        onConnect: () => {
          this.emit("connection:open");
          this.reconnectAttempts = 0;
        },
        onDisconnect: ({ event }) => {
          this.emit("connection:close");
          if (
            this.config.autoReconnect &&
            this.reconnectAttempts < this.maxReconnectAttempts
          ) {
            this.reconnectAttempts++;
            setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
          }
        },
        onAuthenticationFailed: ({ reason }: { reason: string }) => {
          this.emit(
            "auth:error",
            new Error(`Authentication failed: ${reason}`),
          );
        },
        onSynced: () => {
          this.emit("sync:complete");
        },
      });

      // Setup WebRTC provider for P2P sync (optional)
      if (this.config.enableWebRTC && typeof window !== "undefined") {
        this.webrtc = new WebrtcProvider(this.config.roomName, this.doc, {
          signaling: [
            "wss://signaling.yjs.dev",
            "wss://y-webrtc-signaling-eu.herokuapp.com",
            "wss://y-webrtc-signaling-us.herokuapp.com",
          ],
        });
      }

      this.emit("sync:start");
    } catch (error) {
      this.emit(
        "connection:error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  /**
   * Disconnect from all providers
   */
  public disconnect(): void {
    this.hocuspocus?.disconnect();
    this.webrtc?.disconnect();
    this.indexeddb?.destroy();
  }

  /**
   * Destroy the client and clean up resources
   */
  public destroy(): void {
    this.disconnect();
    this.subdocs.forEach((doc) => doc.destroy());
    this.doc.destroy();
  }

  // ================== Authentication Methods ==================

  /**
   * Register a new user
   */
  public async register(userData: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ user: AuthUser; token: string }> {
    const response = await this.apiRequest<{
      user: AuthUser;
      sessionToken: string;
    }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(userData),
    });

    if (response.error) {
      throw new Error(response.error.message);
    }

    const { user, sessionToken } = response.data!;
    this.currentUser = user;
    this.config.token = sessionToken;
    this.tokenStorage.setToken(sessionToken);

    // Update Hocuspocus provider token
    if (this.hocuspocus) {
      this.hocuspocus.configuration.token = sessionToken;
    }

    this.emit("auth:login", user);
    return { user, token: sessionToken };
  }

  /**
   * Login with existing credentials
   */
  public async login(credentials: {
    identifier: string; // username or email
    password: string;
  }): Promise<{ user: AuthUser; token: string }> {
    const response = await this.apiRequest<{
      user: AuthUser;
      sessionToken: string;
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });

    if (response.error) {
      throw new Error(response.error.message);
    }

    const { user, sessionToken } = response.data!;
    this.currentUser = user;
    this.config.token = sessionToken;
    this.tokenStorage.setToken(sessionToken);

    // Update Hocuspocus provider token
    if (this.hocuspocus) {
      this.hocuspocus.configuration.token = sessionToken;
    }

    this.emit("auth:login", user);
    return { user, token: sessionToken };
  }

  /**
   * Logout and clear session
   */
  public async logout(): Promise<void> {
    if (this.config.token) {
      try {
        await this.apiRequest("/api/auth/logout", {
          method: "POST",
        });
      } catch (error) {
        // Ignore logout errors
        console.warn("Logout request failed:", error);
      }
    }

    this.currentUser = null;
    this.config.token = undefined;
    this.tokenStorage.removeToken();

    // Update Hocuspocus provider token
    if (this.hocuspocus) {
      this.hocuspocus.configuration.token = undefined;
    }

    this.emit("auth:logout");
  }

  /**
   * Get current authenticated user
   */
  public getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  /**
   * Check if user is authenticated
   */
  public isAuthenticated(): boolean {
    return !!this.config.token;
  }

  // ================== Document Methods ==================

  /**
   * Fetch the document index from the server
   */
  public async fetchIndex(): Promise<DocumentMetadata[]> {
    const response = await this.apiRequest<{ documents: DocumentMetadata[] }>(
      "/api/documents/",
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const documents = response.data!.documents;

    // Update the collaborative document index
    this.doc.transact(() => {
      documents.forEach((doc) => {
        this.documentIndex.set(doc.path, doc);
      });
    });

    return documents;
  }

  /**
   * Get a document for editing
   */
  public async getDocument(path: string): Promise<Y.Doc> {
    const cachedDoc = this.subdocs.get(path);
    if (cachedDoc) {
      return cachedDoc;
    }

    // Create a new Y.Doc for this document
    const subdoc = new Y.Doc({ guid: `doc:${path}` });

    // Store in cache
    this.subdocs.set(path, subdoc);
    this.documents.set(path, subdoc);

    try {
      // Create a dedicated Hocuspocus provider for this document
      const docProvider = new HocuspocusProvider({
        url: this.config.hocuspocusUrl,
        name: `doc:${path}`,
        document: subdoc,
        token: this.config.token,
      });

      // Wait for initial sync
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Document sync timeout")),
          10000,
        );

        docProvider.on("synced", () => {
          clearTimeout(timeout);
          resolve();
        });

        docProvider.on("connectionError", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.emit("document:loaded", path, subdoc);
      return subdoc;
    } catch (error) {
      this.subdocs.delete(path);
      this.documents.delete(path);
      this.emit(
        "document:error",
        path,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  /**
   * Create a new document
   */
  public async createDocument(
    path: string,
    options: {
      title?: string;
      description?: string;
      initialContent?: string;
      isPublic?: boolean;
    } = {},
  ): Promise<DocumentMetadata> {
    const response = await this.apiRequest<{ document: DocumentMetadata }>(
      `/api/documents/${encodeURIComponent(path)}`,
      {
        method: "POST",
        body: JSON.stringify(options),
      },
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const document = response.data!.document;

    // Update document index
    this.doc.transact(() => {
      this.documentIndex.set(path, document);
    });

    return document;
  }

  /**
   * Update document metadata
   */
  public async updateDocument(
    path: string,
    updates: {
      title?: string;
      description?: string;
      tags?: string[];
      isPublic?: boolean;
    },
  ): Promise<DocumentMetadata> {
    const response = await this.apiRequest<{ document: DocumentMetadata }>(
      `/api/documents/${encodeURIComponent(path)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const document = response.data!.document;

    // Update document index
    this.doc.transact(() => {
      this.documentIndex.set(path, document);
    });

    return document;
  }

  /**
   * Delete a document
   */
  public async deleteDocument(path: string): Promise<void> {
    const response = await this.apiRequest(
      `/api/documents/${encodeURIComponent(path)}`,
      {
        method: "DELETE",
      },
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    // Clean up local state
    this.leaveDocument(path);
    this.doc.transact(() => {
      this.documentIndex.delete(path);
    });
  }

  /**
   * Search documents
   */
  public async searchDocuments(
    query: string,
    options: {
      limit?: number;
      offset?: number;
      onlyPublic?: boolean;
    } = {},
  ): Promise<DocumentMetadata[]> {
    const params = new URLSearchParams({
      query,
      ...Object.fromEntries(
        Object.entries(options).map(([k, v]) => [k, String(v)]),
      ),
    });

    const response = await this.apiRequest<{ documents: DocumentMetadata[] }>(
      `/api/documents/search?${params}`,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.documents;
  }

  /**
   * Leave a document and clean up resources
   */
  public leaveDocument(path: string): void {
    const subdoc = this.subdocs.get(path);
    if (subdoc) {
      subdoc.destroy();
      this.subdocs.delete(path);
      this.documents.delete(path);
    }
  }

  /**
   * Get the collaborative document index
   */
  public getDocumentIndex(): Y.Map<DocumentMetadata> {
    return this.documentIndex;
  }

  // ================== File Upload Methods ==================

  /**
   * Upload a file
   */
  public async uploadFile(
    file: File,
    options: {
      description?: string;
      tags?: string[];
      documentPath?: string;
    } = {},
  ): Promise<FileMetadata> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("filename", file.name);

    if (options.description) {
      formData.append("description", options.description);
    }
    if (options.tags) {
      formData.append("tags", JSON.stringify(options.tags));
    }
    if (options.documentPath) {
      formData.append("documentPath", options.documentPath);
    }

    const response = await this.apiRequest<{ file: FileMetadata }>(
      "/api/uploads/",
      {
        method: "POST",
        body: formData,
        headers: undefined, // Let browser set Content-Type with boundary
      },
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.file;
  }

  /**
   * List uploaded files
   */
  public async listFiles(
    options: {
      limit?: number;
      offset?: number;
      documentPath?: string;
    } = {},
  ): Promise<FileMetadata[]> {
    const params = new URLSearchParams(
      Object.fromEntries(
        Object.entries(options).map(([k, v]) => [k, String(v)]),
      ),
    );

    const response = await this.apiRequest<{ files: FileMetadata[] }>(
      `/api/uploads/?${params}`,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.files;
  }

  /**
   * Delete a file
   */
  public async deleteFile(fileId: string): Promise<void> {
    const response = await this.apiRequest(`/api/uploads/${fileId}`, {
      method: "DELETE",
    });

    if (response.error) {
      throw new Error(response.error.message);
    }
  }

  // ================== User Management Methods ==================

  /**
   * Get user profile
   */
  public async getUserProfile(): Promise<AuthUser> {
    const response = await this.apiRequest<{ user: AuthUser }>(
      "/api/auth/profile",
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.user;
  }

  /**
   * Update user profile
   */
  public async updateProfile(updates: {
    displayName?: string;
    email?: string;
    settings?: Record<string, any>;
  }): Promise<AuthUser> {
    const response = await this.apiRequest<{ user: AuthUser }>(
      "/api/auth/profile",
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const user = response.data!.user;
    this.currentUser = user;
    return user;
  }

  /**
   * Change password
   */
  public async changePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const response = await this.apiRequest("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: oldPassword,
        newPassword: newPassword,
      }),
    });

    if (response.error) {
      throw new Error(response.error.message);
    }
  }

  // ================== Admin Methods ==================

  /**
   * List all users (admin only)
   */
  public async listUsers(
    options: {
      limit?: number;
      offset?: number;
      search?: string;
    } = {},
  ): Promise<AuthUser[]> {
    const params = new URLSearchParams(
      Object.fromEntries(
        Object.entries(options).map(([k, v]) => [k, String(v)]),
      ),
    );

    const response = await this.apiRequest<{ users: AuthUser[] }>(
      `/api/admin/users?${params}`,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.users;
  }

  /**
   * Get system stats (admin only)
   */
  public async getSystemStats(): Promise<any> {
    const response = await this.apiRequest<any>("/api/admin/stats");

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data;
  }

  // ================== Utility Methods ==================

  /**
   * Make an authenticated API request
   */
  private async apiRequest<T = any>(
    endpoint: string,
    options: RequestInit & {
      headers?: Record<string, string> | undefined;
    } = {},
  ): Promise<ApiResponse<T>> {
    const url = `${this.config.serverUrl}${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    // Add authorization header if token is available
    if (this.config.token) {
      headers["Authorization"] = `Bearer ${this.config.token}`;
    }

    // Don't override Content-Type for FormData
    if (options.body instanceof FormData) {
      delete headers["Content-Type"];
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: {
            code: "UNKNOWN_ERROR",
            message: `HTTP ${response.status}: ${response.statusText}`,
          },
        }));
        return errorData;
      }

      const data = await response.json();
      return data;
    } catch (error) {
      return {
        error: {
          code: "NETWORK_ERROR",
          message:
            error instanceof Error ? error.message : "Network request failed",
        },
      };
    }
  }

  /**
   * Setup network status monitoring
   */
  private setupNetworkMonitoring(): void {
    if (typeof window === "undefined") return;

    window.addEventListener("online", () => {
      this.isOnline = true;
      this.emit("online");
      if (this.config.autoReconnect) {
        this.connect().catch(console.error);
      }
    });

    window.addEventListener("offline", () => {
      this.isOnline = false;
      this.emit("offline");
    });

    this.isOnline = navigator.onLine;
  }

  /**
   * Get current network status
   */
  public isOnlineStatus(): boolean {
    return this.isOnline;
  }

  /**
   * Get connection status
   */
  public getConnectionStatus(): {
    online: boolean;
    hocuspocus: boolean;
    webrtc: boolean;
    indexeddb: boolean;
  } {
    return {
      online: this.isOnline,
      hocuspocus: this.hocuspocus?.status === "connected",
      webrtc: this.webrtc?.connected || false,
      indexeddb: !!this.indexeddb,
    };
  }
}
