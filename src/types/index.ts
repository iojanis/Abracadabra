// Type Definitions for Abracadabra Server
// Based on the unified implementation specification

// ============================================================================
// User Management Types
// ============================================================================

export interface UserObject {
  id: string; // UUID
  username: string; // Unique, URL-safe identifier
  email?: string; // Optional for authentication
  displayName: string; // Human-readable name
  hashedPassword?: string; // For local auth
  avatar?: string; // Profile picture URL
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
  settings: UserSettings;
}

export interface UserSettings {
  defaultPermissions?: PermissionLevel;
  emailNotifications?: boolean;
  maxNestingDepth?: number; // User-specific limit
}

// ============================================================================
// Hierarchical Document Types
// ============================================================================

export interface DocumentMetadataObject {
  id: string; // UUID for the document
  name: string; // Document name (last path segment)
  path: string; // Complete path: "/Jay/Getting-Started/Introduction"
  fullPath: string; // Complete path: "/Jay/Getting-Started/Introduction"
  ownerId: string; // User ID of document owner
  parentPath?: string | undefined; // Parent document path (null for root documents)
  depth: number; // Nesting level (0 for root documents)

  // Document metadata fields
  title: string;
  description: string;
  tags: string[];
  size: number;
  version: number;
  is_public: boolean;
  isArchived: boolean;
  collaborator_count: number;

  permissions: DocumentPermissions;

  createdAt: Date;
  updatedAt: Date;
  updated_at: number; // Unix timestamp
  lastAccessedAt: Date;
  last_accessed_at: number; // Unix timestamp
}

export interface DocumentDetails {
  metadata: DocumentMetadataObject;
  permissions?: DocumentPermissions;
  children?: string[]; // Child document paths
  title: string;
  description: string;
  tags: string[];
  fileSize: number;
  size: number;
  wordCount?: number;
  version: number;
  isPublic: boolean;
  isArchived: boolean;
  collaboratorCount: number;
  collaborator_count: number;
  updated_at: number;
}

export interface DocumentPermissions {
  inheritFromParent: boolean;
  inherit_from_parent: boolean; // snake_case version for backwards compatibility
  publicAccess: PermissionLevel;
  public_access: PermissionLevel; // snake_case version for backwards compatibility
  owner: string; // User ID of owner
  editors: string[]; // User IDs with editor access
  commenters: string[]; // User IDs with commenter access
  viewers: string[]; // User IDs with viewer access
}

// ============================================================================
// Permission System Types
// ============================================================================

export interface PermissionObject {
  userId: string;
  docPath: string; // Full document path
  role: PermissionLevel;
  grantedBy: string; // User ID who granted permission
  grantedAt: Date;
  expiresAt?: Date;
  explicit: boolean; // true if set directly, false if inherited
}

export type PermissionLevel =
  | "NONE"
  | "VIEWER"
  | "COMMENTER"
  | "EDITOR"
  | "ADMIN"
  | "OWNER";

// ============================================================================
// Session Management Types
// ============================================================================

export interface SessionObject {
  id: string; // Session token (UUID)
  userId: string;
  userAgent?: string;
  ipAddress?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// ============================================================================
// Webhook System Types
// ============================================================================

export interface WebhookObject {
  id: string;
  url: string;
  secret?: string;
  events: TriggerEvent[];
  isActive: boolean;
  createdAt: Date;
  lastTriggeredAt?: Date;
  failureCount: number;
}

export type TriggerEvent =
  | "onStoreDocument"
  | "onConnect"
  | "onChange"
  | "onAwarenessUpdate";

export interface HookScriptObject {
  id: string;
  name: string;
  content: string; // JavaScript/TypeScript code
  triggers: TriggerEvent[];
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastExecutedAt?: Date;
  executionCount: number;
  averageExecutionTime: number;
  memoryLimit: number; // MB
  timeoutLimit: number; // seconds
}

export interface ScriptExecutionContext {
  docPath: string;
  event: TriggerEvent;
  user?: Pick<UserObject, "id" | "username" | "displayName">;
  data?: any;
  timestamp: Date;
}

// ============================================================================
// File Upload System Types
// ============================================================================

export interface UploadUrl {
  uploadUrl: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  fileId: string;
  expiresAt: Date;
}

// ============================================================================
// Configuration Types
// ============================================================================

export type ConfigKey = ["config", string];
export type ConfigValue = any;

export interface DocumentCreateOptions {
  title?: string;
  description?: string;
  initialContent?: string;
  isPublic?: boolean;
  permissions?: DocumentPermissions;
}

export interface DocumentUpdateOptions {
  title?: string;
  description?: string;
  tags?: string[];
  isPublic?: boolean;
}

export interface DocumentListOptions {
  includePermissions?: boolean;
  includeChildren?: boolean;
  limit?: number;
  offset?: number;
}

export interface DocumentSearchOptions {
  limit?: number;
  offset?: number;
  onlyPublic?: boolean;
}

// ============================================================================
// Server Configuration Types
// ============================================================================

export interface ServerConfig {
  // Server
  port: number;
  host: string;

  // Database
  kv_path?: string;

  // Authentication
  jwt_secret: string;
  session_timeout: number; // seconds

  // Documents
  max_nesting_depth: number;
  max_document_size: number; // bytes
  max_collaborators_per_doc: number;

  // File Storage
  upload_strategy: "local" | "s3";
  local_upload_path: string;
  s3_bucket?: string;
  s3_region?: string;
  s3_access_key?: string;
  s3_secret_key?: string;

  // Logging
  log_level: "DEBUG" | "INFO" | "WARN" | "ERROR";

  // Features
  enable_public_documents: boolean;
  enable_webhooks: boolean;
  enable_scripting: boolean;
  enable_file_uploads: boolean;

  // Rate Limiting
  rate_limit_window_ms: number;
  rate_limit_max_requests: number;
}

export type DocumentStats = {
  totalDocuments: number;
  totalSize: number;
  lastUpdated: number;
  activeCollaborators: number;
};

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
  };
}

export interface ApiResponse<T = any> {
  data?: T;
  error?: ApiError["error"];
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    hasMore?: boolean;
  };
}

// ============================================================================
// WebSocket Protocol Types
// ============================================================================

export interface CollaborationMessage {
  type: "auth" | "sync" | "update" | "awareness";
  token?: string; // For authentication
  update?: Uint8Array; // Yjs update
  awareness?: any; // Awareness information
  queryVector?: Uint8Array; // For sync
}

// ============================================================================
// Deno KV Key Structure Types
// ============================================================================

// Users: ["users", userId] → UserObject
// Sessions: ["sessions", sessionId] → SessionObject
// Documents:
//   - Metadata: ["documents", "metadata", fullPath] → DocumentMetadataObject
//   - Yjs State: ["documents", "yjs_state", fullPath] → Uint8Array
//   - Children: ["documents", "children", fullPath] → string[]
//   - Permissions: ["documents", "permissions", fullPath] → DocumentPermissions
//   - By User: ["documents", "by_user", username] → string[]
// Webhooks: ["webhooks", webhookId] → WebhookObject
// Scripts: ["scripts", scriptId] → HookScriptObject
// Files: ["files", fileId] → FileMetadataObject
// Config: ["config", key] → any

export type KvKey =
  | ["users", string]
  | ["sessions", string]
  | ["documents", "metadata", string]
  | ["documents", "yjs_state", string]
  | ["documents", "children", string]
  | ["documents", "permissions", string]
  | ["documents", "by_user", string]
  | ["webhooks", string]
  | ["scripts", string]
  | ["files", string]
  | ["config", string];

// ============================================================================
// WebSocket Polyfill Types (for Deno compatibility)
// ============================================================================

export interface PolyfilliedWebSocket extends WebSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  setMaxListeners?(maxListeners: number): void;
  getMaxListeners?(): number;
  listenerCount?(event: string): number;
  removeAllListeners?(event?: string): void;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ERROR_CODES = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  INVALID_PATH: "INVALID_PATH",
  MAX_DEPTH_EXCEEDED: "MAX_DEPTH_EXCEEDED",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INVALID_INPUT: "INVALID_INPUT",
  DUPLICATE_RESOURCE: "DUPLICATE_RESOURCE",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ============================================================================
// File Upload Types
// ============================================================================

export interface FileMetadataObject {
  id: string; // UUID
  filename: string; // Current filename
  originalFilename: string; // Original uploaded filename
  mimeType: string; // MIME type of the file
  size: number; // File size in bytes
  uploadedBy: string; // User ID who uploaded the file
  uploadedAt: Date; // Upload timestamp
  documentPath?: string; // Associated document path (optional)
  description?: string; // File description (optional)
  tags?: string[]; // File tags (optional)
  downloadCount: number; // Number of times downloaded
  storageProvider: "local" | "s3"; // Storage provider used
  storagePath?: string; // Internal storage path
}

// ============================================================================
// Database Key Types
// ============================================================================

export type UserKey = ["users", "by_id", string];
export type UsernameIndexKey = ["users", "by_username", string];
export type EmailIndexKey = ["users", "by_email", string];
export type SessionKey = ["sessions", string];
