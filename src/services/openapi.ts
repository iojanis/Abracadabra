// OpenAPI Documentation Service for Abracadabra Server
// Generates comprehensive API documentation with Swagger UI support

import { getLogger } from "./logging.ts";
import type { ConfigService } from "./config.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getOpenApiLogger() {
  if (!logger) {
    logger = getLogger(["openapi"]);
  }
  return logger;
}

// OpenAPI specification interfaces
export interface OpenAPISpec {
  openapi: string;
  info: Info;
  servers: Server[];
  paths: Paths;
  components: Components;
  security: SecurityRequirement[];
}

export interface Info {
  title: string;
  description: string;
  version: string;
  contact?: Contact;
  license?: License;
}

export interface Contact {
  name: string;
  url?: string;
  email?: string;
}

export interface License {
  name: string;
  url?: string;
}

export interface Server {
  url: string;
  description: string;
}

export interface Paths {
  [path: string]: PathItem;
}

export interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  delete?: Operation;
  patch?: Operation;
  head?: Operation;
  options?: Operation;
}

export interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Responses;
  security?: SecurityRequirement[];
}

export interface Parameter {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  description?: string;
  required?: boolean;
  schema: Schema;
}

export interface RequestBody {
  description?: string;
  content: { [mediaType: string]: MediaType };
  required?: boolean;
}

export interface MediaType {
  schema: Schema;
  examples?: { [name: string]: Example };
}

export interface Example {
  summary?: string;
  description?: string;
  value?: any;
}

export interface Responses {
  [statusCode: string]: Response;
}

export interface Response {
  description: string;
  content?: { [mediaType: string]: MediaType };
  headers?: { [name: string]: Header };
}

export interface Header {
  description?: string;
  schema: Schema;
}

export interface Components {
  schemas?: { [name: string]: Schema };
  securitySchemes?: { [name: string]: SecurityScheme };
}

export interface Schema {
  type?: string;
  format?: string;
  properties?: { [name: string]: Schema };
  items?: Schema;
  required?: string[];
  enum?: any[];
  example?: any;
  description?: string;
  $ref?: string;
  default?: any;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | Schema;
}

export interface SecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  scheme?: string;
  bearerFormat?: string;
  in?: "query" | "header" | "cookie";
  name?: string;
}

export interface SecurityRequirement {
  [name: string]: string[];
}

export class OpenAPIService {
  private config: ConfigService;
  private spec: OpenAPISpec;

  constructor(config: ConfigService) {
    this.config = config;
    this.spec = this.createBaseSpec();
  }

  /**
   * Initialize the OpenAPI service
   */
  async initialize(): Promise<void> {
    await this.generateSpec();
    getOpenApiLogger().info("OpenAPI service initialized");
  }

  /**
   * Get the complete OpenAPI specification
   */
  getSpec(): OpenAPISpec {
    return this.spec;
  }

  /**
   * Get the OpenAPI specification as JSON string
   */
  getSpecJSON(): string {
    return JSON.stringify(this.spec, null, 2);
  }

  /**
   * Get the OpenAPI specification as YAML string
   */
  getSpecYAML(): string {
    // Simple YAML conversion (for production, use a proper YAML library)
    return this.jsonToYaml(this.spec);
  }

  /**
   * Generate Swagger UI HTML
   */
  getSwaggerUI(specUrl: string = "/api/docs/openapi.json"): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Abracadabra Server API Documentation" />
  <title>Abracadabra API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '${specUrl}',
        dom_id: '#swagger-ui',
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.presets.standalone,
        ],
        layout: "StandaloneLayout",
        deepLinking: true,
        showExtensions: true,
        showCommonExtensions: true,
        tryItOutEnabled: true,
      });
    };
  </script>
</body>
</html>`;
  }

  /**
   * Create base OpenAPI specification
   */
  private createBaseSpec(): OpenAPISpec {
    return {
      openapi: "3.0.3",
      info: {
        title: "Abracadabra Server API",
        description:
          "Professional-grade collaborative document server with hierarchical organization and real-time collaboration",
        version: "1.0.0",
        contact: {
          name: "Abracadabra Team",
        },
        license: {
          name: "MIT",
        },
      },
      servers: [
        {
          url: "http://localhost:8787",
          description: "Development server",
        },
      ],
      paths: {},
      components: {
        schemas: this.createSchemas(),
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "UUID",
          },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "session",
          },
        },
      },
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    };
  }

  /**
   * Generate the complete OpenAPI specification
   */
  private async generateSpec(): Promise<void> {
    this.spec.paths = {
      ...this.generateAuthPaths(),
      ...this.generateDocumentPaths(),
      ...this.generateUploadPaths(),
      ...this.generateAdminPaths(),
    };
  }

  /**
   * Generate authentication endpoint paths
   */
  private generateAuthPaths(): Paths {
    return {
      "/api/auth/register": {
        post: {
          tags: ["Authentication"],
          summary: "Register a new user",
          description:
            "Create a new user account with automatic namespace permission bootstrapping",
          operationId: "registerUser",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RegisterRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "User registered successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            "400": {
              description: "Invalid input or validation error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Username or email already exists",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
          security: [],
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Authentication"],
          summary: "Login user",
          description: "Authenticate user with username/email and password",
          operationId: "loginUser",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Login successful",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            "401": {
              description: "Invalid credentials",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
          security: [],
        },
      },
      "/api/auth/logout": {
        post: {
          tags: ["Authentication"],
          summary: "Logout user",
          description: "Invalidate current session",
          operationId: "logoutUser",
          responses: {
            "200": {
              description: "Logout successful",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SuccessResponse" },
                },
              },
            },
          },
        },
      },
    };
  }

  /**
   * Generate document endpoint paths
   */
  private generateDocumentPaths(): Paths {
    return {
      "/api/documents/": {
        get: {
          tags: ["Documents"],
          summary: "List user documents",
          description: "Get list of documents accessible to the current user",
          operationId: "listDocuments",
          responses: {
            "200": {
              description: "Documents retrieved successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DocumentListResponse" },
                },
              },
            },
          },
        },
      },
      "/api/documents/{path}": {
        post: {
          tags: ["Documents"],
          summary: "Create document",
          description: "Create a new document at the specified path",
          operationId: "createDocument",
          parameters: [
            {
              name: "path",
              in: "path",
              required: true,
              description: "Document path (e.g., /username/folder/document)",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateDocumentRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Document created successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DocumentResponse" },
                },
              },
            },
            "403": {
              description: "Insufficient permissions",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        get: {
          tags: ["Documents"],
          summary: "Get document",
          description: "Retrieve document metadata and content",
          operationId: "getDocument",
          parameters: [
            {
              name: "path",
              in: "path",
              required: true,
              description: "Document path",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Document retrieved successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DocumentResponse" },
                },
              },
            },
            "404": {
              description: "Document not found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        put: {
          tags: ["Documents"],
          summary: "Update document",
          description: "Update document metadata and content",
          operationId: "updateDocument",
          parameters: [
            {
              name: "path",
              in: "path",
              required: true,
              description: "Document path",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateDocumentRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Document updated successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DocumentResponse" },
                },
              },
            },
          },
        },
        delete: {
          tags: ["Documents"],
          summary: "Delete document",
          description: "Delete a document and all its content",
          operationId: "deleteDocument",
          parameters: [
            {
              name: "path",
              in: "path",
              required: true,
              description: "Document path",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Document deleted successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SuccessResponse" },
                },
              },
            },
          },
        },
      },
    };
  }

  /**
   * Generate upload endpoint paths
   */
  private generateUploadPaths(): Paths {
    return {
      "/api/uploads/": {
        post: {
          tags: ["File Uploads"],
          summary: "Upload file",
          description: "Upload a file attachment",
          operationId: "uploadFile",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "File to upload",
                    },
                    filename: {
                      type: "string",
                      description: "Custom filename (optional)",
                    },
                    description: {
                      type: "string",
                      description: "File description",
                    },
                    documentPath: {
                      type: "string",
                      description: "Associated document path",
                    },
                    tags: {
                      type: "array",
                      items: { type: "string" },
                      description: "File tags",
                    },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "File uploaded successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/UploadResponse" },
                },
              },
            },
            "400": {
              description: "Invalid file or upload error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        get: {
          tags: ["File Uploads"],
          summary: "List user files",
          description: "Get list of files uploaded by the current user",
          operationId: "listUserFiles",
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Maximum number of files to return",
              schema: { type: "integer", default: 50 },
            },
            {
              name: "offset",
              in: "query",
              description: "Number of files to skip",
              schema: { type: "integer", default: 0 },
            },
          ],
          responses: {
            "200": {
              description: "Files retrieved successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileListResponse" },
                },
              },
            },
          },
        },
      },
      "/api/uploads/{fileId}": {
        get: {
          tags: ["File Uploads"],
          summary: "Get file metadata",
          description: "Retrieve file metadata",
          operationId: "getFileMetadata",
          parameters: [
            {
              name: "fileId",
              in: "path",
              required: true,
              description: "File ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "File metadata retrieved successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileMetadataResponse" },
                },
              },
            },
            "404": {
              description: "File not found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        delete: {
          tags: ["File Uploads"],
          summary: "Delete file",
          description: "Delete a file and its metadata",
          operationId: "deleteFile",
          parameters: [
            {
              name: "fileId",
              in: "path",
              required: true,
              description: "File ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "File deleted successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SuccessResponse" },
                },
              },
            },
          },
        },
      },
      "/api/uploads/{fileId}/download": {
        get: {
          tags: ["File Uploads"],
          summary: "Download file",
          description: "Download file content",
          operationId: "downloadFile",
          parameters: [
            {
              name: "fileId",
              in: "path",
              required: true,
              description: "File ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "File content",
              content: {
                "*/*": {
                  schema: {
                    type: "string",
                    format: "binary",
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  /**
   * Generate admin endpoint paths
   */
  private generateAdminPaths(): Paths {
    return {
      "/api/admin/config": {
        get: {
          tags: ["Administration"],
          summary: "Get configuration",
          description: "Retrieve server configuration",
          operationId: "getConfig",
          responses: {
            "200": {
              description: "Configuration retrieved successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ConfigResponse" },
                },
              },
            },
          },
        },
        put: {
          tags: ["Administration"],
          summary: "Update configuration",
          description: "Update server configuration",
          operationId: "updateConfig",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConfigUpdateRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Configuration updated successfully",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ConfigResponse" },
                },
              },
            },
          },
        },
      },
    };
  }

  /**
   * Create component schemas
   */
  private createSchemas(): { [name: string]: Schema } {
    return {
      // Authentication schemas
      RegisterRequest: {
        type: "object",
        properties: {
          username: { type: "string", minLength: 3, maxLength: 50 },
          password: { type: "string", minLength: 8 },
          email: { type: "string", format: "email" },
          displayName: { type: "string", minLength: 1, maxLength: 100 },
        },
        required: ["username", "password", "displayName"],
      },
      LoginRequest: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "Username or email" },
          password: { type: "string" },
        },
        required: ["identifier", "password"],
      },
      AuthResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          user: { $ref: "#/components/schemas/User" },
          session: { $ref: "#/components/schemas/Session" },
        },
        required: ["success"],
      },

      // User schemas
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          email: { type: "string" },
          displayName: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          isActive: { type: "boolean" },
        },
        required: [
          "id",
          "username",
          "displayName",
          "createdAt",
          "updatedAt",
          "isActive",
        ],
      },
      Session: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "userId", "expiresAt", "createdAt"],
      },

      // Document schemas
      CreateDocumentRequest: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          initialContent: { type: "string" },
          isPublic: { type: "boolean", default: false },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      UpdateDocumentRequest: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          isPublic: { type: "boolean" },
        },
      },
      DocumentResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: { $ref: "#/components/schemas/Document" },
        },
        required: ["success"],
      },
      Document: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          createdBy: { type: "string" },
          isPublic: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          permissions: { $ref: "#/components/schemas/DocumentPermissions" },
        },
      },
      DocumentListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: {
            type: "object",
            properties: {
              documents: {
                type: "array",
                items: { $ref: "#/components/schemas/Document" },
              },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
        },
      },
      DocumentPermissions: {
        type: "object",
        properties: {
          owner: { type: "string" },
          admins: { type: "array", items: { type: "string" } },
          editors: { type: "array", items: { type: "string" } },
          commenters: { type: "array", items: { type: "string" } },
          viewers: { type: "array", items: { type: "string" } },
          publicAccess: {
            type: "string",
            enum: ["NONE", "VIEWER", "COMMENTER", "EDITOR"],
          },
        },
      },

      // File upload schemas
      UploadResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: {
            type: "object",
            properties: {
              fileId: { type: "string" },
              filename: { type: "string" },
              url: { type: "string" },
              size: { type: "number" },
            },
          },
        },
      },
      FileMetadataResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: { $ref: "#/components/schemas/FileMetadata" },
        },
      },
      FileMetadata: {
        type: "object",
        properties: {
          id: { type: "string" },
          filename: { type: "string" },
          originalFilename: { type: "string" },
          mimeType: { type: "string" },
          size: { type: "number" },
          uploadedBy: { type: "string" },
          uploadedAt: { type: "string", format: "date-time" },
          documentPath: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          downloadCount: { type: "number" },
        },
      },
      FileListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: {
            type: "object",
            properties: {
              files: {
                type: "array",
                items: { $ref: "#/components/schemas/FileMetadata" },
              },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
        },
      },

      // Common schemas
      SuccessResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["success"],
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            required: ["code", "message"],
          },
        },
        required: ["error"],
      },
      Pagination: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          total: { type: "number" },
        },
      },
      ConfigResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: { type: "object", additionalProperties: true },
        },
      },
      ConfigUpdateRequest: {
        type: "object",
        additionalProperties: true,
      },
    };
  }

  /**
   * Convert JSON to YAML (simplified implementation)
   */
  private jsonToYaml(obj: any, indent = 0): string {
    const spaces = "  ".repeat(indent);
    let yaml = "";

    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        yaml += `${spaces}${key}:`;
        if (typeof value === "object" && value !== null) {
          yaml += "\n" + this.jsonToYaml(value, indent + 1);
        } else {
          yaml += ` ${JSON.stringify(value)}\n`;
        }
      }
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        yaml += `${spaces}-`;
        if (typeof item === "object" && item !== null) {
          yaml += "\n" + this.jsonToYaml(item, indent + 1);
        } else {
          yaml += ` ${JSON.stringify(item)}\n`;
        }
      }
    }

    return yaml;
  }
}

// Singleton instance
let openApiService: OpenAPIService | null = null;

/**
 * Get the global OpenAPI service instance
 */
export function getOpenAPIService(): OpenAPIService {
  if (!openApiService) {
    throw new Error(
      "OpenAPI service not initialized. Call createOpenAPIService() first.",
    );
  }
  return openApiService;
}

/**
 * Create and initialize the global OpenAPI service
 */
export async function createOpenAPIService(
  config: ConfigService,
): Promise<OpenAPIService> {
  if (openApiService) {
    return openApiService;
  }

  openApiService = new OpenAPIService(config);
  await openApiService.initialize();
  getOpenApiLogger().info("OpenAPI service initialized");
  return openApiService;
}
