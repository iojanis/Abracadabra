import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebrtcProvider } from "y-webrtc";
import { HocuspocusProvider } from "@hocuspocus/provider";

// ===============================================================================
// TYPE DEFINITIONS - Enhanced for complete server parity
// ===============================================================================

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
 * Session information
 */
export interface SessionInfo {
  id: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string;
  ipAddress: string;
  isActive: boolean;
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
 * Document statistics
 */
export interface DocumentStats {
  path: string;
  size: number;
  version: number;
  collaborators: number;
  lastEdited: string;
  edits: number;
  views: number;
}

/**
 * Document node for hierarchical tree
 */
export interface DocumentNode {
  path: string;
  metadata: DocumentMetadata;
  parent: DocumentNode | null;
  children: Map<string, DocumentNode>;
  effectivePermissions: EffectivePermissions;
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
 * Permission levels matching server exactly
 */
export enum PermissionLevel {
  NONE = 0,
  VIEWER = 1,
  COMMENTER = 2,
  EDITOR = 3,
  ADMIN = 4,
  OWNER = 5
}

/**
 * Effective permissions calculated with inheritance
 */
export interface EffectivePermissions {
  level: PermissionLevel;
  canView: boolean;
  canComment: boolean;
  canEdit: boolean;
  canAdmin: boolean;
  canDelete: boolean;
  inheritedFrom: string | null;
}

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
 * System statistics for admin
 */
export interface SystemStats {
  users: {
    total: number;
    active: number;
    new: number;
  };
  documents: {
    total: number;
    public: number;
    private: number;
    size: number;
  };
  files: {
    total: number;
    size: number;
  };
  sessions: {
    active: number;
    total: number;
  };
  system: {
    uptime: number;
    memory: number;
    storage: number;
  };
}

/**
 * Health status
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    database: boolean;
    storage: boolean;
    auth: boolean;
    collaboration: boolean;
  };
  timestamp: string;
}

/**
 * Maintenance operation result
 */
export interface MaintenanceResult {
  operation: string;
  success: boolean;
  duration: number;
  details: string;
  timestamp: string;
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

// ===============================================================================
// OFFLINE OPERATION QUEUE - New comprehensive implementation
// ===============================================================================

/**
 * Offline operation definition
 */
interface OfflineOperation {
  id: string;
  type: 'api' | 'upload' | 'delete';
  endpoint: string;
  method: string;
  payload: any;
  headers?: Record<string, string>;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  priority: 'high' | 'medium' | 'low';
  dependsOn?: string[];
}

/**
 * Conflict resolution strategy
 */
interface ConflictResolution {
  strategy: 'server-wins' | 'client-wins' | 'merge' | 'prompt-user';
  merge?: (server: any, client: any) => any;
}

/**
 * Offline operation queue with robust conflict resolution
 */
class OfflineOperationQueue {
  private queue: OfflineOperation[] = [];
  private processing = false;
  private storage: IDBDatabase | null = null;

  constructor(private client: AbracadabraClient) {
    this.initStorage();
  }

  private async initStorage(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('abracadabra_offline_queue', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.storage = request.result;
        this.loadQueueFromStorage();
        resolve();
      };
      
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('operations')) {
          const store = db.createObjectStore('operations', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp');
          store.createIndex('priority', 'priority');
        }
      };
    });
  }

  async enqueue(operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'retryCount'>): Promise<string> {
    const op: OfflineOperation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: 3,
      ...operation
    };

    this.queue.push(op);
    await this.saveOperationToStorage(op);
    
    if (this.client.isOnlineStatus() && !this.processing) {
      this.processQueue();
    }

    return op.id;
  }

  async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    this.client.emit('sync:start');

    try {
      this.queue.sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        return priorityDiff !== 0 ? priorityDiff : a.timestamp - b.timestamp;
      });

      const results = await Promise.allSettled(
        this.queue.map(op => this.processOperation(op))
      );

      const failedOps = this.queue.filter((_, index) => 
        results[index].status === 'rejected'
      );

      for (const op of failedOps) {
        if (op.retryCount < op.maxRetries) {
          op.retryCount++;
          await this.saveOperationToStorage(op);
        } else {
          await this.removeOperationFromStorage(op.id);
        }
      }

      const successfulOps = this.queue.filter((_, index) => 
        results[index].status === 'fulfilled'
      );
      
      for (const op of successfulOps) {
        await this.removeOperationFromStorage(op.id);
      }

      this.queue = this.queue.filter(op => 
        op.retryCount > 0 && op.retryCount < op.maxRetries
      );

    } finally {
      this.processing = false;
      this.client.emit('sync:complete');
    }
  }

  private async processOperation(operation: OfflineOperation): Promise<any> {
    const { endpoint, method, payload, headers } = operation;

    try {
      if (operation.dependsOn) {
        const pendingDeps = operation.dependsOn.filter(depId => 
          this.queue.some(op => op.id === depId)
        );
        if (pendingDeps.length > 0) {
          throw new Error(`Dependencies not met: ${pendingDeps.join(', ')}`);
        }
      }

      const response = await this.client.apiRequest(endpoint, {
        method,
        body: payload ? JSON.stringify(payload) : undefined,
        headers
      });

      if (response.error) {
        if (response.error.code === 'CONFLICT' || response.error.code === 'VERSION_MISMATCH') {
          return await this.handleConflict(operation, response.error.details);
        }
        throw new Error(response.error.message);
      }

      return response.data;
    } catch (error) {
      console.error(`Operation ${operation.id} failed:`, error);
      throw error;
    }
  }

  private async handleConflict(operation: OfflineOperation, serverData: any): Promise<any> {
    const resolution: ConflictResolution = this.getConflictResolution(operation);

    switch (resolution.strategy) {
      case 'server-wins':
        return serverData;

      case 'client-wins':
        const forceResponse = await this.client.apiRequest(operation.endpoint, {
          method: operation.method,
          body: JSON.stringify({ ...operation.payload, force: true }),
          headers: operation.headers
        });
        if (forceResponse.error) throw new Error(forceResponse.error.message);
        return forceResponse.data;

      case 'merge':
        if (!resolution.merge) throw new Error('Merge function not provided');
        const merged = resolution.merge(serverData, operation.payload);
        const mergeResponse = await this.client.apiRequest(operation.endpoint, {
          method: operation.method,
          body: JSON.stringify(merged),
          headers: operation.headers
        });
        if (mergeResponse.error) throw new Error(mergeResponse.error.message);
        return mergeResponse.data;

      case 'prompt-user':
        this.client.emit('sync:conflict', {
          operation,
          serverData,
          clientData: operation.payload
        });
        throw new Error('User intervention required for conflict resolution');

      default:
        throw new Error(`Unknown conflict resolution strategy: ${resolution.strategy}`);
    }
  }

  private getConflictResolution(operation: OfflineOperation): ConflictResolution {
    if (operation.endpoint.includes('/documents/')) {
      return {
        strategy: 'merge',
        merge: (server, client) => ({
          ...server,
          ...client,
          updatedAt: new Date().toISOString()
        })
      };
    }
    
    return { strategy: 'server-wins' };
  }

  private async saveOperationToStorage(operation: OfflineOperation): Promise<void> {
    if (!this.storage) return;
    
    const transaction = this.storage.transaction(['operations'], 'readwrite');
    const store = transaction.objectStore('operations');
    await store.put(operation);
  }

  private async removeOperationFromStorage(operationId: string): Promise<void> {
    if (!this.storage) return;
    
    const transaction = this.storage.transaction(['operations'], 'readwrite');
    const store = transaction.objectStore('operations');
    await store.delete(operationId);
  }

  private async loadQueueFromStorage(): Promise<void> {
    if (!this.storage) return;
    
    const transaction = this.storage.transaction(['operations'], 'readonly');
    const store = transaction.objectStore('operations');
    const request = store.getAll();
    
    request.onsuccess = () => {
      this.queue = request.result || [];
    };
  }

  // Public methods
  async retry(operationId: string): Promise<void> {
    const operation = this.queue.find(op => op.id === operationId);
    if (operation) {
      operation.retryCount = 0;
      await this.processQueue();
    }
  }

  async cancel(operationId: string): Promise<void> {
    this.queue = this.queue.filter(op => op.id !== operationId);
    await this.removeOperationFromStorage(operationId);
  }

  getQueueStatus(): { total: number; pending: number; failed: number } {
    const failed = this.queue.filter(op => op.retryCount >= op.maxRetries).length;
    return {
      total: this.queue.length,
      pending: this.queue.length - failed,
      failed
    };
  }
}

// ===============================================================================
// HIERARCHICAL DOCUMENT TREE MANAGER - New implementation
// ===============================================================================

/**
 * Document tree manager for hierarchical operations
 */
class DocumentTreeManager {
  private tree: Map<string, DocumentNode> = new Map();
  
  constructor(private client: AbracadabraClient) {}

  buildTree(documents: DocumentMetadata[]): void {
    this.tree.clear();
    
    const sortedDocs = documents.sort((a, b) => 
      a.path.split('/').length - b.path.split('/').length
    );
    
    for (const doc of sortedDocs) {
      this.insertDocument(doc);
    }
  }

  private insertDocument(metadata: DocumentMetadata): void {
    const pathParts = metadata.path.split('/');
    const parentPath = pathParts.slice(0, -1).join('/');
    
    const node: DocumentNode = {
      path: metadata.path,
      metadata,
      parent: parentPath ? this.tree.get(parentPath) || null : null,
      children: new Map(),
      effectivePermissions: this.calculateEffectivePermissions(metadata)
    };
    
    if (node.parent) {
      node.parent.children.set(pathParts[pathParts.length - 1], node);
    }
    
    this.tree.set(metadata.path, node);
  }

  getChildren(path: string): DocumentNode[] {
    const node = this.tree.get(path);
    return node ? Array.from(node.children.values()) : [];
  }

  getBreadcrumbs(path: string): DocumentNode[] {
    const breadcrumbs: DocumentNode[] = [];
    let currentNode = this.tree.get(path);
    
    while (currentNode) {
      breadcrumbs.unshift(currentNode);
      currentNode = currentNode.parent;
    }
    
    return breadcrumbs;
  }

  private calculateEffectivePermissions(metadata: DocumentMetadata): EffectivePermissions {
    const currentUser = this.client.getCurrentUser();
    if (!currentUser) {
      return {
        level: PermissionLevel.NONE,
        canView: false,
        canComment: false,
        canEdit: false,
        canAdmin: false,
        canDelete: false,
        inheritedFrom: null
      };
    }

    let level = PermissionLevel.NONE;

    // Check ownership
    if (metadata.ownerId === currentUser.id) {
      level = PermissionLevel.OWNER;
    } else if (metadata.permissions.editors.includes(currentUser.username)) {
      level = PermissionLevel.EDITOR;
    } else if (metadata.permissions.commenters.includes(currentUser.username)) {
      level = PermissionLevel.COMMENTER;
    } else if (metadata.permissions.viewers.includes(currentUser.username)) {
      level = PermissionLevel.VIEWER;
    } else if (metadata.isPublic) {
      level = metadata.permissions.publicAccess;
    }

    return {
      level,
      canView: level >= PermissionLevel.VIEWER,
      canComment: level >= PermissionLevel.COMMENTER,
      canEdit: level >= PermissionLevel.EDITOR,
      canAdmin: level >= PermissionLevel.ADMIN,
      canDelete: level >= PermissionLevel.OWNER,
      inheritedFrom: metadata.permissions.inheritFromParent ? 
        this.getInheritanceSource(metadata.path) : null
    };
  }

  private getInheritanceSource(path: string): string | null {
    const pathParts = path.split('/');
    const parentPath = pathParts.slice(0, -1).join('/');
    return parentPath || null;
  }
}

// ===============================================================================
// PERMISSION MANAGER - New comprehensive permission system
// ===============================================================================

/**
 * Permission manager for access control
 */
class PermissionManager {
  constructor(private client: AbracadabraClient) {}

  async getPermissions(path: string): Promise<DocumentPermissions> {
    const response = await this.client.apiRequest<{ permissions: DocumentPermissions }>(
      `/api/documents/${encodeURIComponent(path)}/permissions`
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.permissions;
  }

  async updatePermissions(
    path: string, 
    permissions: Partial<DocumentPermissions>
  ): Promise<DocumentPermissions> {
    const response = await this.client.apiRequest<{ permissions: DocumentPermissions }>(
      `/api/documents/${encodeURIComponent(path)}/permissions`,
      {
        method: 'PUT',
        body: JSON.stringify(permissions)
      }
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.permissions;
  }

  async grantPermission(
    path: string,
    username: string,
    level: PermissionLevel
  ): Promise<void> {
    const response = await this.client.apiRequest(
      `/api/documents/${encodeURIComponent(path)}/permissions/grant`,
      {
        method: 'POST',
        body: JSON.stringify({ username, level })
      }
    );

    if (response.error) {
      throw new Error(response.error.message);
    }
  }

  async revokePermission(path: string, username: string): Promise<void> {
    const response = await this.client.apiRequest(
      `/api/documents/${encodeURIComponent(path)}/permissions/revoke`,
      {
        method: 'POST',
        body: JSON.stringify({ username })
      }
    );

    if (response.error) {
      throw new Error(response.error.message);
    }
  }

  calculateEffectivePermissions(
    userPermissions: DocumentPermissions,
    currentUser: AuthUser
  ): EffectivePermissions {
    let level = PermissionLevel.NONE;
    
    if (userPermissions.editors.includes(currentUser.username)) {
      level = PermissionLevel.EDITOR;
    } else if (userPermissions.commenters.includes(currentUser.username)) {
      level = PermissionLevel.COMMENTER;
    } else if (userPermissions.viewers.includes(currentUser.username)) {
      level = PermissionLevel.VIEWER;
    } else {
      level = userPermissions.publicAccess;
    }
    
    return {
      level,
      canView: level >= PermissionLevel.VIEWER,
      canComment: level >= PermissionLevel.COMMENTER,
      canEdit: level >= PermissionLevel.EDITOR,
      canAdmin: level >= PermissionLevel.ADMIN,
      canDelete: level >= PermissionLevel.OWNER,
      inheritedFrom: userPermissions.inheritFromParent ? 'parent' : null
    };
  }

  requirePermission(level: PermissionLevel) {
    return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
      const method = descriptor.value;
      
      descriptor.value = async function(this: AbracadabraClient, ...args: any[]) {
        const path = args[0];
        const permissions = await this.permissions.getEffectivePermissions(path);
        
        if (permissions.level < level) {
          throw new Error(`Insufficient permissions. Required: ${PermissionLevel[level]}`);
        }
        
        return method.apply(this, args);
      };
    };
  }
}

// ===============================================================================
// ADMIN MANAGER - Complete admin API implementation
// ===============================================================================

/**
 * Admin API Manager for system administration
 */
class AdminManager {
  constructor(private client: AbracadabraClient) {}

  async getConfig(): Promise<Record<string, any>> {
    const response = await this.client.apiRequest<{ config: Record<string, any> }>('/api/admin/config');
    if (response.error) throw new Error(response.error.message);
    return response.data!.config;
  }

  async updateConfig(config: Record<string, any>): Promise<Record<string, any>> {
    const response = await this.client.apiRequest<{ config: Record<string, any> }>(
      '/api/admin/config',
      { method: 'PUT', body: JSON.stringify({ config }) }
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!.config;
  }

  async getConfigValue(key: string): Promise<any> {
    const response = await this.client.apiRequest<{ value: any }>(`/api/admin/config/${key}`);
    if (response.error) throw new Error(response.error.message);
    return response.data!.value;
  }

  async setConfigValue(key: string, value: any): Promise<void> {
    const response = await this.client.apiRequest(
      `/api/admin/config/${key}`,
      { method: 'PUT', body: JSON.stringify({ value }) }
    );
    if (response.error) throw new Error(response.error.message);
  }

  async getSystemStats(): Promise<SystemStats> {
    const response = await this.client.apiRequest<SystemStats>('/api/admin/stats');
    if (response.error) throw new Error(response.error.message);
    return response.data!;
  }

  async getUser(username: string): Promise<AuthUser> {
    const response = await this.client.apiRequest<{ user: AuthUser }>(`/api/admin/users/${username}`);
    if (response.error) throw new Error(response.error.message);
    return response.data!.user;
  }

  async updateUser(username: string, updates: Partial<AuthUser>): Promise<AuthUser> {
    const response = await this.client.apiRequest<{ user: AuthUser }>(
      `/api/admin/users/${username}`,
      { method: 'PUT', body: JSON.stringify(updates) }
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!.user;
  }

  async deleteUser(username: string): Promise<void> {
    const response = await this.client.apiRequest(`/api/admin/users/${username}`, {
      method: 'DELETE'
    });
    if (response.error) throw new Error(response.error.message);
  }

  async getAllSessions(): Promise<SessionInfo[]> {
    const response = await this.client.apiRequest<{ sessions: SessionInfo[] }>('/api/admin/sessions');
    if (response.error) throw new Error(response.error.message);
    return response.data!.sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await this.client.apiRequest(`/api/admin/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    if (response.error) throw new Error(response.error.message);
  }

  async performMaintenance(operation: 'cleanup' | 'optimize' | 'backup' | 'migrate'): Promise<MaintenanceResult> {
    const response = await this.client.apiRequest<MaintenanceResult>(
      '/api/admin/maintenance',
      { method: 'POST', body: JSON.stringify({ operation }) }
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!;
  }

  async getHealthStatus(): Promise<HealthStatus> {
    const response = await this.client.apiRequest<HealthStatus>('/api/admin/health');
    if (response.error) throw new Error(response.error.message);
    return response.data!;
  }
}

// ===============================================================================
// STORAGE INTERFACE - Token management
// ===============================================================================

interface TokenStorage {
  getToken(): string | null;
  setToken(token: string): void;
  removeToken(): void;
}

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

// ===============================================================================
// EVENT SYSTEM - Enhanced events
// ===============================================================================

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
  "sync:conflict": (data: { operation: OfflineOperation; serverData: any; clientData: any }) => void;
  offline: () => void;
  online: () => void;
  [key: string]: (...args: any[]) => void;
}

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

// ===============================================================================
// ENHANCED ABRACADABRA CLIENT - Complete implementation
// ===============================================================================

/**
 * The main client for interacting with the Abracadabra server.
 * Enhanced with complete server API coverage, offline-first capabilities,
 * hierarchical document management, and advanced permission system.
 */
export class AbracadabraClient extends EventEmitter<ClientEvents> {
  public doc: Y.Doc;
  private config: AbracadabraClientConfig;
  private tokenStorage: TokenStorage;

  // Providers
  private indexeddb: IndexeddbPersistence | null = null;
  private webrtc: WebrtcProvider | null = null;
  private hocuspocus: HocuspocusProvider | null = null;

  // Document management
  private subdocs = new Map<string, Y.Doc>();
  private documents: Y.Map<Y.Doc>;
  private documentIndex: Y.Map<DocumentMetadata>;

  // State
  private currentUser: AuthUser | null = null;
  private isOnline: boolean = true;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  // Enhanced managers
  private offlineQueue: OfflineOperationQueue;
  private documentTree: DocumentTreeManager;
  public permissions: PermissionManager;
  public admin: AdminManager;

  // Singleton prevention flag
  private static preventDirectInstantiation = false;

  constructor(config: AbracadabraClientConfig) {
    super();
    
    if (!AbracadabraClient.preventDirectInstantiation) {
      console.warn('Direct AbracadabraClient instantiation detected. Consider using AbracadabraClientManager for singleton pattern.');
    }
    
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

    // Initialize enhanced managers
    this.offlineQueue = new OfflineOperationQueue(this);
    this.documentTree = new DocumentTreeManager(this);
    this.permissions = new PermissionManager(this);
    this.admin = new AdminManager(this);

    // Load existing token if available
    if (!this.config.token) {
      this.config.token = this.tokenStorage.getToken() || undefined;
    }

    // Setup network status monitoring
    this.setupNetworkMonitoring();
  }

  /**
   * Factory method for singleton creation
   */
  static create(config: AbracadabraClientConfig): AbracadabraClient {
    AbracadabraClient.preventDirectInstantiation = true;
    const client = new AbracadabraClient(config);
    AbracadabraClient.preventDirectInstantiation = false;
    return client;
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
          // Process offline queue when connection is restored
          this.offlineQueue.processQueue();
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

  public disconnect(): void {
    this.hocuspocus?.disconnect();
    this.webrtc?.disconnect();
    this.indexeddb?.destroy();
  }

  public destroy(): void {
    this.disconnect();
    this.subdocs.forEach((doc) => doc.destroy());
    this.doc.destroy();
  }

  // ===============================================================================
  // AUTHENTICATION METHODS - Enhanced with session management
  // ===============================================================================

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

    if (this.hocuspocus) {
      this.hocuspocus.configuration.token = sessionToken;
    }

    this.emit("auth:login", user);
    return { user, token: sessionToken };
  }

  public async login(credentials: {
    identifier: string;
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

    if (this.hocuspocus) {
      this.hocuspocus.configuration.token = sessionToken;
    }

    this.emit("auth:login", user);
    return { user, token: sessionToken };
  }

  public async logout(): Promise<void> {
    if (this.config.token) {
      try {
        await this.apiRequest("/api/auth/logout", {
          method: "POST",
        });
      } catch (error) {
        console.warn("Logout request failed:", error);
      }
    }

    this.currentUser = null;
    this.config.token = undefined;
    this.tokenStorage.removeToken();

    if (this.hocuspocus) {
      this.hocuspocus.configuration.token = undefined;
    }

    this.emit("auth:logout");
  }

  public getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  public isAuthenticated(): boolean {
    return !!this.config.token;
  }

  public async getUserProfile(): Promise<AuthUser> {
    const response = await this.apiRequest<{ user: AuthUser }>(
      "/api/auth/profile",
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.data!.user;
  }

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

  // NEW: Session management methods
  public async getUserSessions(): Promise<SessionInfo[]> {
    const response = await this.apiRequest<{ sessions: SessionInfo[] }>('/api/auth/sessions');
    if (response.error) throw new Error(response.error.message);
    return response.data!.sessions;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const response = await this.apiRequest(`/api/auth/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    if (response.error) throw new Error(response.error.message);
  }

  // ===============================================================================
  // DOCUMENT METHODS - Enhanced with hierarchy and permissions
  // ===============================================================================

  public async fetchIndex(): Promise<DocumentMetadata[]> {
    const response = await this.apiRequest<{ documents: DocumentMetadata[] }>(
      "/api/documents/",
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const documents = response.data!.documents;

    // Update the collaborative document index and tree
    this.doc.transact(() => {
      documents.forEach((doc) => {
        this.documentIndex.set(doc.path, doc);
      });
    });

    this.documentTree.buildTree(documents);

    return documents;
  }

  public async getDocument(path: string): Promise<Y.Doc> {
    const cachedDoc = this.subdocs.get(path);
    if (cachedDoc) {
      return cachedDoc;
    }

    const subdoc = new Y.Doc({ guid: `doc:${path}` });
    this.subdocs.set(path, subdoc);
    this.documents.set(path, subdoc);

    try {
      const docProvider = new HocuspocusProvider({
        url: this.config.hocuspocusUrl,
        name: `doc:${path}`,
        document: subdoc,
        token: this.config.token,
      });

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

  public async createDocument(
    path: string,
    options: {
      title?: string;
      description?: string;
      initialContent?: string;
      isPublic?: boolean;
    } = {},
  ): Promise<DocumentMetadata> {
    // Queue for offline if not online
    if (!this.isOnlineStatus()) {
      await this.offlineQueue.enqueue({
        type: 'api',
        endpoint: `/api/documents/${encodeURIComponent(path)}`,
        method: 'POST',
        payload: options,
        priority: 'high'
      });
      
      // Return optimistic response
      const optimisticDoc: DocumentMetadata = {
        id: crypto.randomUUID(),
        path,
        title: options.title,
        description: options.description,
        ownerId: this.currentUser?.id || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPublic: options.isPublic || false,
        size: 0,
        tags: [],
        version: 1,
        permissions: {
          inheritFromParent: false,
          publicAccess: PermissionLevel.NONE,
          editors: [],
          commenters: [],
          viewers: []
        }
      };
      
      this.doc.transact(() => {
        this.documentIndex.set(path, optimisticDoc);
      });
      
      return optimisticDoc;
    }

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

    this.doc.transact(() => {
      this.documentIndex.set(path, document);
    });

    return document;
  }

  public async updateDocument(
    path: string,
    updates: {
      title?: string;
      description?: string;
      tags?: string[];
      isPublic?: boolean;
    },
  ): Promise<DocumentMetadata> {
    if (!this.isOnlineStatus()) {
      await this.offlineQueue.enqueue({
        type: 'api',
        endpoint: `/api/documents/${encodeURIComponent(path)}`,
        method: 'PATCH',
        payload: updates,
        priority: 'medium'
      });
      
      // Apply optimistic update
      const currentDoc = this.documentIndex.get(path);
      if (currentDoc) {
        const updatedDoc = { ...currentDoc, ...updates, updatedAt: new Date().toISOString() };
        this.doc.transact(() => {
          this.documentIndex.set(path, updatedDoc);
        });
        return updatedDoc;
      }
    }

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

    this.doc.transact(() => {
      this.documentIndex.set(path, document);
    });

    return document;
  }

  public async deleteDocument(path: string): Promise<void> {
    if (!this.isOnlineStatus()) {
      await this.offlineQueue.enqueue({
        type: 'api',
        endpoint: `/api/documents/${encodeURIComponent(path)}`,
        method: 'DELETE',
        payload: null,
        priority: 'high'
      });
      
      // Apply optimistic update
      this.leaveDocument(path);
      this.doc.transact(() => {
        this.documentIndex.delete(path);
      });
      return;
    }

    const response = await this.apiRequest(
      `/api/documents/${encodeURIComponent(path)}`,
      {
        method: "DELETE",
      },
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    this.leaveDocument(path);
    this.doc.transact(() => {
      this.documentIndex.delete(path);
    });
  }

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

  public leaveDocument(path: string): void {
    const subdoc = this.subdocs.get(path);
    if (subdoc) {
      subdoc.destroy();
      this.subdocs.delete(path);
      this.documents.delete(path);
    }
  }

  public getDocumentIndex(): Y.Map<DocumentMetadata> {
    return this.documentIndex;
  }

  // NEW: Hierarchical document methods
  public async getChildren(path: string): Promise<DocumentMetadata[]> {
    const response = await this.apiRequest<{ children: DocumentMetadata[] }>(
      `/api/documents/${encodeURIComponent(path)}/children`
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!.children;
  }

  public getBreadcrumbs(path: string): DocumentNode[] {
    return this.documentTree.getBreadcrumbs(path);
  }

  public getDocumentTree(): DocumentTreeManager {
    return this.documentTree;
  }

  // NEW: Document permission methods
  public async getDocumentPermissions(path: string): Promise<DocumentPermissions> {
    return await this.permissions.getPermissions(path);
  }

  public async updateDocumentPermissions(path: string, permissions: Partial<DocumentPermissions>): Promise<DocumentPermissions> {
    return await this.permissions.updatePermissions(path, permissions);
  }

  public async grantPermission(path: string, username: string, level: PermissionLevel): Promise<void> {
    return await this.permissions.grantPermission(path, username, level);
  }

  public async revokePermission(path: string, username: string): Promise<void> {
    return await this.permissions.revokePermission(path, username);
  }

  // NEW: Document statistics
  public async getDocumentStats(path: string): Promise<DocumentStats> {
    const response = await this.apiRequest<DocumentStats>(
      `/api/documents/${encodeURIComponent(path)}/stats`
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!;
  }

  // NEW: Yjs state access
  public async getDocumentYjsState(path: string): Promise<Uint8Array> {
    const response = await this.apiRequest<{ state: string }>(
      `/api/documents/${encodeURIComponent(path)}/yjs`
    );
    if (response.error) throw new Error(response.error.message);
    return new Uint8Array(Buffer.from(response.data!.state, 'base64'));
  }

  // ===============================================================================
  // FILE MANAGEMENT - Complete implementation
  // ===============================================================================

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

  public async deleteFile(fileId: string): Promise<void> {
    const response = await this.apiRequest(`/api/uploads/${fileId}`, {
      method: "DELETE",
    });

    if (response.error) {
      throw new Error(response.error.message);
    }
  }

  // NEW: Enhanced file management methods
  public async getFileMetadata(fileId: string): Promise<FileMetadata> {
    const response = await this.apiRequest<{ file: FileMetadata }>(
      `/api/uploads/${fileId}`
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!.file;
  }

  public async downloadFile(fileId: string): Promise<Blob> {
    const response = await fetch(`${this.config.serverUrl}/api/uploads/${fileId}/download`, {
      headers: { 'Authorization': `Bearer ${this.config.token}` }
    });
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
    return await response.blob();
  }

  public async getFilesByDocument(documentPath: string): Promise<FileMetadata[]> {
    const response = await this.apiRequest<{ files: FileMetadata[] }>(
      `/api/uploads/document/${encodeURIComponent(documentPath)}`
    );
    if (response.error) throw new Error(response.error.message);
    return response.data!.files;
  }

  public async getUploadStatus(): Promise<{ enabled: boolean; maxSize: number; providers: string[] }> {
    const response = await this.apiRequest<any>('/api/uploads/status');
    if (response.error) throw new Error(response.error.message);
    return response.data!;
  }

  public async cleanupOrphanedFiles(): Promise<{ deleted: number; errors: string[] }> {
    const response = await this.apiRequest<any>('/api/uploads/cleanup', {
      method: 'POST'
    });
    if (response.error) throw new Error(response.error.message);
    return response.data!;
  }

  // ===============================================================================
  // ADMIN METHODS - Complete implementation
  // ===============================================================================

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

  public async getSystemStats(): Promise<SystemStats> {
    return await this.admin.getSystemStats();
  }

  // ===============================================================================
  // UTILITY METHODS - Enhanced with offline support
  // ===============================================================================

  public async apiRequest<T = any>(
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

    if (this.config.token) {
      headers["Authorization"] = `Bearer ${this.config.token}`;
    }

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

  private setupNetworkMonitoring(): void {
    if (typeof window === "undefined") return;

    window.addEventListener("online", () => {
      this.isOnline = true;
      this.emit("online");
      if (this.config.autoReconnect) {
        this.connect().catch(console.error);
      }
      // Process offline queue when back online
      this.offlineQueue.processQueue();
    });

    window.addEventListener("offline", () => {
      this.isOnline = false;
      this.emit("offline");
    });

    this.isOnline = navigator.onLine;
  }

  public isOnlineStatus(): boolean {
    return this.isOnline;
  }

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

  // NEW: Offline queue management
  public getOfflineQueueStatus(): { total: number; pending: number; failed: number } {
    return this.offlineQueue.getQueueStatus();
  }

  public async retryOfflineOperation(operationId: string): Promise<void> {
    return this.offlineQueue.retry(operationId);
  }

  public async cancelOfflineOperation(operationId: string): Promise<void> {
    return this.offlineQueue.cancel(operationId);
  }
}

// ===============================================================================
// SINGLETON MANAGER - Complete implementation
// ===============================================================================

/**
 * Singleton manager for Abracadabra client instances
 * Ensures single client instance across application lifecycle
 */
export class AbracadabraClientManager {
  private static instance: AbracadabraClient | null = null;
  private static config: AbracadabraClientConfig | null = null;
  private static connectionPromise: Promise<void> | null = null;

  /**
   * Get or create singleton client instance
   */
  static getInstance(config?: AbracadabraClientConfig): AbracadabraClient {
    if (!this.instance) {
      if (!config) {
        throw new Error('Configuration required for first initialization');
      }
      this.instance = AbracadabraClient.create(config);
      this.config = config;
    }
    return this.instance;
  }

  /**
   * Connect client with connection deduplication
   */
  static async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    const client = this.getInstance();
    this.connectionPromise = client.connect();
    
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Safe client destruction with cleanup
   */
  static destroy(): void {
    if (this.instance) {
      this.instance.destroy();
      this.instance = null;
      this.config = null;
      this.connectionPromise = null;
    }
  }

  /**
   * Check if client is initialized
   */
  static isInitialized(): boolean {
    return this.instance !== null;
  }

  /**
   * Get current configuration
   */
  static getConfig(): AbracadabraClientConfig | null {
    return this.config;
  }
}