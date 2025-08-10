// Main Application Entry Point for Abracadabra Server
// Professional-grade collaborative document server built on Deno

import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket } from "hono/deno";
import { Hocuspocus } from "@hocuspocus/server";

import { createConfigService, type ConfigService } from "./services/config.ts";
import { createLoggingService, getLogger } from "./services/logging.ts";
import { ensureNodeJSMethods } from "./extensions/websocket-polyfill.ts";
import type { ServerConfig } from "./types/index.ts";

// Import services
import { AuthService, createAuthService } from "./auth.ts";
import {
  createDocumentService,
  type DocumentService,
} from "./services/documents.ts";
import {
  createPermissionService,
  type PermissionService,
} from "./services/permissions.ts";
import {
  createScriptsService,
  type ScriptsService,
} from "./services/scripts.ts";
import {
  createUploadsService,
  type UploadsService,
} from "./services/uploads.ts";
import {
  createOpenAPIService,
  type OpenAPIService,
} from "./services/openapi.ts";

// Import middleware
import { createSessionMiddleware } from "./middleware/session.ts";

// Import routes
import { AuthRoutes } from "./routes/auth.ts";
import { DocumentRoutes } from "./routes/documents.ts";
import { AdminRoutes } from "./routes/admin.ts";
import { UploadRoutes } from "./routes/uploads.ts";
import { DocsRoutes } from "./routes/docs.ts";

// Import authentication middleware
import {
  requireAuth,
  optionalAuth,
  requireAdmin,
  rateLimit,
  apiCors,
} from "./middleware/auth.ts";

// Import Hocuspocus extension
import { DenoKvExtension } from "./extensions/deno-kv.ts";

// Import session middleware
import type { SessionMiddleware } from "./middleware/session.ts";

class AbracadabraServer {
  private app: Hono;
  private kv!: Deno.Kv;
  private config!: ServerConfig;
  private hocuspocus!: Hocuspocus;
  private logger!: ReturnType<typeof getLogger>;

  // Services
  private configService!: ConfigService;
  private documentService!: DocumentService;
  private permissionService!: PermissionService;
  private authService!: AuthService;
  private sessionMiddleware!: SessionMiddleware;
  private scriptsService!: ScriptsService;
  private uploadsService!: UploadsService;
  private openApiService!: OpenAPIService;

  constructor() {
    this.app = new Hono();
  }

  /**
   * Initialize and start the Abracadabra server
   */
  async start(): Promise<void> {
    try {
      // Initialize logging first (without config service)
      await createLoggingService();
      this.logger = getLogger(["main"]);

      this.logger.info("🎩 Starting Abracadabra Server...");

      // 1. Initialize core services
      await this.initializeServices();

      // 2. Setup middleware
      this.setupMiddleware();

      // 3. Setup routes
      this.setupRoutes();

      // 4. Initialize real-time collaboration
      await this.initializeCollaboration();

      // 5. Start HTTP server
      await this.startHttpServer();

      this.logger.info("🚀 Abracadabra Server started successfully!");
    } catch (error) {
      this.logger.error("Failed to start Abracadabra Server", {
        error: (error as Error).message,
      });
      await this.cleanup();
      Deno.exit(1);
    }
  }

  /**
   * Initialize core services (Config, Logging, Database)
   */
  private async initializeServices(): Promise<void> {
    this.logger.info("Initializing core services...");

    // Initialize Deno KV
    const kvPath = Deno.env.get("ABRACADABRA_KV_PATH") || "./data/kv.db";
    this.kv = await Deno.openKv(kvPath);
    this.logger.info("Deno KV initialized", {
      kvPath: kvPath || "./data/kv.db",
    });

    // Initialize configuration service
    const configService = await createConfigService(this.kv);
    this.configService = configService;
    const partialConfig = await configService.getServerConfig();
    this.config = partialConfig as ServerConfig;
    this.logger.info("Configuration service initialized");

    // Re-initialize logging with config (if not already done)
    await createLoggingService(configService);
    this.logger.info("Logging service re-initialized with config");

    // Initialize document service
    this.documentService = await createDocumentService(this.kv, configService);
    this.logger.info("Document service initialized");

    // Initialize permission service
    this.permissionService = await createPermissionService(
      this.kv,
      configService,
    );
    this.logger.info("Permission service initialized");

    // Initialize auth service
    this.authService = await createAuthService(
      this.kv,
      configService,
      this.permissionService,
    );
    this.logger.info("Auth service initialized");

    // Initialize scripts service
    this.scriptsService = await createScriptsService(
      this.kv,
      configService,
      this.documentService,
      this.permissionService,
    );
    this.logger.info("Scripts service initialized");

    // Initialize uploads service
    this.uploadsService = await createUploadsService(
      this.kv,
      configService,
      this.permissionService,
    );
    this.logger.info("Uploads service initialized");

    // Initialize OpenAPI service
    this.openApiService = await createOpenAPIService(configService);
    this.logger.info("OpenAPI service initialized");

    // Initialize session middleware
    const { SessionMiddleware } = await import("./middleware/session.ts");
    this.sessionMiddleware = new SessionMiddleware(this.kv, {
      requireAuth: false, // Default to optional auth, routes can override
    });
    this.logger.info("Session middleware initialized");

    this.logger.info("Core services initialized successfully");
  }

  /**
   * Setup application middleware
   */
  private setupMiddleware(): void {
    this.logger.info("Setting up middleware...");

    // CORS middleware
    this.app.use(
      "*",
      cors({
        origin: (origin) => {
          // In production, you'd want to configure allowed origins
          const isProduction = Deno.env.get("DENO_ENV") === "production";
          if (!isProduction) {
            return origin; // Allow all origins in development
          }

          // TODO: Configure allowed origins from config
          return origin || "";
        },
        allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
        credentials: true,
      }),
    );

    // Request logging middleware (basic implementation)
    this.app.use("*", async (c, next) => {
      const start = Date.now();
      const requestId = crypto.randomUUID().substring(0, 8);

      // Set request ID in context for use in other middleware/routes
      // c.set("requestId", requestId); // TODO: Fix Hono context typing

      await next();

      const duration = Date.now() - start;
      const status = c.res.status;

      this.logger.info(
        `${c.req.method} ${c.req.path} - ${status} (${duration}ms)`,
        {
          method: c.req.method,
          path: c.req.path,
          status,
          duration,
          requestId,
        },
      );
    });

    // Session middleware (applied to all routes except auth and health)
    this.app.use("*", this.sessionMiddleware.handle());

    // Rate limiting middleware
    this.app.use(
      "/api/*",
      rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxRequests: 1000, // limit each IP to 1000 requests per windowMs
      }),
    );

    // API CORS middleware
    this.app.use(
      "/api/*",
      apiCors({
        allowedOrigins: ["*"], // Configure in production
        allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Session-Token"],
      }),
    );

    // TODO: Add other middleware
    // this.app.use("*", rateLimitMiddleware());

    this.logger.info("Middleware setup complete");
  }

  /**
   * Setup application routes
   */
  private setupRoutes(): void {
    this.logger.info("Setting up routes...");

    // Health check endpoint
    this.app.get("/health", (c) => {
      return c.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        services: {
          kv: "connected",
          config: "loaded",
          logging: "active",
        },
      });
    });

    // Root endpoint
    this.app.get("/", (c) => {
      return c.json({
        name: "Abracadabra Server",
        description: "Professional-grade collaborative document server",
        version: "1.0.0",
        docs: "/docs",
        health: "/health",
        api: "/api",
      });
    });

    // Redirect docs to API documentation
    this.app.get("/docs", (c) => {
      return c.redirect("/api/docs/ui");
    });

    // Mount API routes with proper middleware

    // Authentication routes (no auth required)
    const authRoutes = new AuthRoutes(this.kv, this.authService);
    this.app.route("/api/auth", authRoutes.getApp());

    // Document routes (with optional/required auth)
    const documentRoutes = new DocumentRoutes(
      this.kv,
      this.documentService,
      this.permissionService,
    );
    this.app.route("/api/documents", documentRoutes.getApp());

    // Upload routes (auth required)
    const uploadRoutes = new UploadRoutes();
    this.app.route("/api/uploads", uploadRoutes.getApp());

    // Admin routes (admin auth required)
    const adminRoutes = new AdminRoutes(
      this.kv,
      this.configService,
      this.documentService,
      this.permissionService,
    );
    this.app.route("/api/admin", adminRoutes.getApp());

    // Documentation routes (public)
    const docsRoutes = new DocsRoutes();
    this.app.route("/api/docs", docsRoutes.getApp());

    this.logger.info("API routes mounted", {
      auth: "/api/auth/*",
      documents: "/api/documents/*",
      uploads: "/api/uploads/*",
      admin: "/api/admin/*",
      docs: "/api/docs/*",
    });

    // Catch-all for unmatched API routes
    this.app.all("/api/*", (c) => {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "API endpoint not found",
            timestamp: new Date().toISOString(),
          },
        },
        404,
      );
    });

    // 404 handler
    this.app.notFound((c) => {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found",
            path: c.req.path,
            timestamp: new Date().toISOString(),
          },
        },
        404,
      );
    });

    // Global error handler
    this.app.onError((error, c) => {
      this.logger.error("Unhandled application error", {
        error: error.message,
        stack: error.stack,
        path: c.req.path,
        method: c.req.method,
      });

      return c.json(
        {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "An internal server error occurred",
            timestamp: new Date().toISOString(),
          },
        },
        500,
      );
    });

    this.logger.info("Routes setup complete");
  }

  /**
   * Initialize real-time collaboration
   */
  private async initializeCollaboration(): Promise<void> {
    this.logger.info("Initializing real-time collaboration...");

    const denoKvExtension = new DenoKvExtension(this.kv, {
      debounceInterval: 2000,
      maxRetries: 3,
      enableMetrics: true,
    });
    const collaborationLogger = this.logger; // Capture logger for callback context

    // Initialize Hocuspocus server
    this.hocuspocus = new Hocuspocus({
      name: "abracadabra-collaboration",

      // TODO: Implement authentication
      async onAuthenticate(data: any) {
        collaborationLogger.info("WebSocket authentication request", {
          documentName: data.documentName,
          hasToken: !!data.token,
        });

        // For now, allow all connections
        // TODO: Implement proper authentication
        return true;
      },

      // TODO: Implement authorization
      async onConnect(data: any) {
        collaborationLogger.info("WebSocket connection established", {
          documentName: data.documentName,
          connectionId: data.connection.id,
        });

        // TODO: Check user permissions for the document
        return true;
      },

      // Add the Deno KV extension for persistence
      extensions: [denoKvExtension],

      async onStoreDocument(data: any) {
        collaborationLogger.info("Document state stored", {
          documentName: data.documentName,
          size: data.document.getByteLength(),
        });
      },

      async onChange(data: any) {
        collaborationLogger.debug("Document changed", {
          documentName: data.documentName,
          clientsCount: data.clientsCount,
        });
      },
    });

    // WebSocket upgrade handler
    const hocuspocusServer = this.hocuspocus;
    // WebSocket collaboration endpoint
    const wsLogger = this.logger; // Capture logger for WebSocket callbacks

    this.app.get(
      "/collaborate/*",
      // Optional authentication for WebSocket - public documents can be accessed anonymously
      optionalAuth(),
      upgradeWebSocket((c) => {
        const path = c.req.path.replace("/collaborate", "");
        const userId = c.get("userId");
        const username = c.get("username");

        return {
          async onOpen(_evt, ws) {
            wsLogger.info("WebSocket connection opened", {
              path,
              userId: userId || "anonymous",
              username: username || "anonymous",
            });

            // Apply WebSocket polyfill for Hocuspocus compatibility
            if (ws.raw) {
              const polyfilliedWS = ensureNodeJSMethods(ws.raw);

              // Create minimal request object for Hocuspocus compatibility
              const fakeRequest = {
                url: path,
                method: "GET",
                headers: Object.fromEntries(c.req.raw.headers.entries()),
                connection: { remoteAddress: "127.0.0.1" },
                user: userId ? { id: userId, username } : null,
              } as any;

              hocuspocusServer.handleConnection(polyfilliedWS, fakeRequest);
            }
          },
          onMessage(evt, ws) {
            wsLogger.debug("WebSocket message received", {
              path,
              userId: userId || "anonymous",
              messageType: typeof evt.data,
              size: evt.data ? evt.data.toString().length : 0,
            });
          },
          onClose(evt, ws) {
            wsLogger.info("WebSocket connection closed", {
              path,
              userId: userId || "anonymous",
              code: evt.code,
              reason: evt.reason,
            });
          },
          onError(evt, ws) {
            wsLogger.error("WebSocket error", {
              path,
              userId: userId || "anonymous",
              error: evt,
            });
          },
        };
      }),
    );

    this.logger.info("Real-time collaboration initialized");

    // Log available collaboration endpoints
    this.logger.info("Collaboration endpoints available", {
      websocket: "/collaborate/*",
      note: "WebSocket connections support both authenticated and anonymous users for public documents",
    });
  }

  /**
   * Start the HTTP server
   */
  private async startHttpServer(): Promise<void> {
    const { port, host } = this.config;

    this.logger.info("Starting HTTP server...", { port, host });

    // Setup graceful shutdown
    this.setupGracefulShutdown();

    // Start the server
    Deno.serve({
      port: port || 8787,
      hostname: host || "0.0.0.0",
      handler: this.app.fetch,
    });

    this.logger.info(`🎯 Server listening on http://${host}:${port}`, {
      port,
      host,
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      this.logger.info("Received shutdown signal", { signal });
      await this.cleanup();
      Deno.exit(0);
    };

    // Handle process signals
    Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
    Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

    // Handle unhandled promise rejections
    globalThis.addEventListener("unhandledrejection", (event) => {
      this.logger.error("Unhandled promise rejection", {
        reason: event.reason,
        stack: event.reason?.stack,
      });

      event.preventDefault();
    });

    // Handle uncaught exceptions
    globalThis.addEventListener("error", (event) => {
      this.logger.error("Uncaught exception", {
        error: event.error?.message,
        stack: event.error?.stack,
        filename: event.filename,
        lineno: event.lineno,
      });
    });
  }

  /**
   * Cleanup resources before shutdown
   */
  private async cleanup(): Promise<void> {
    this.logger.info("Cleaning up resources...");

    try {
      // Hocuspocus will handle its own cleanup
      if (this.hocuspocus) {
        await this.hocuspocus.destroy();
      }

      // Close Hocuspocus server
      if (this.hocuspocus) {
        await this.hocuspocus.destroy();
        this.logger.info("Hocuspocus server closed");
      }

      // Close Deno KV
      if (this.kv) {
        this.kv.close();
        this.logger.info("Deno KV connection closed");
      }

      this.logger.info("Cleanup completed");
    } catch (error) {
      this.logger.error("Error during cleanup", {
        error: (error as Error).message,
      });
    }
  }
}

// ============================================================================
// Application Bootstrap
// ============================================================================

async function bootstrap(): Promise<void> {
  const mainLogger = {
    info: (msg: string, extra?: any) =>
      console.info(`[INFO] bootstrap: ${msg}`, extra || {}),
    error: (msg: string, extra?: any) =>
      console.error(`[ERROR] bootstrap: ${msg}`, extra || {}),
  };

  try {
    mainLogger.info("🎩 Bootstrapping Abracadabra Server...");

    // Check required permissions
    const status = await Deno.permissions.query({ name: "net" });
    if (status.state !== "granted") {
      throw new Error(
        "Network permission required. Run with --allow-net flag.",
      );
    }

    // Create and start server
    const server = new AbracadabraServer();
    await server.start();
  } catch (error) {
    mainLogger.error("Failed to bootstrap server", {
      error: (error as Error).message,
    });
    Deno.exit(1);
  }
}

// Start the application
if (import.meta.main) {
  bootstrap();
}

export { AbracadabraServer };
