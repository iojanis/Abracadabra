// Main Application Entry Point for Abracadabra Server
// Professional-grade collaborative document server built on Deno

import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket } from "hono/deno";
import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import { type ConfigService, createConfigService } from "./services/config.ts";
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

// Import utilities
import {
  isDenoDeploy,
  getEnvironmentInfo,
  getDeploymentId,
  getLoggerPrefix,
} from "./utils/environment.ts";

// Import middleware
import { createSessionMiddleware } from "./middleware/session.ts";

// Import routes
import { AuthRoutes } from "./routes/auth.ts";
import { DocumentRoutes } from "./routes/documents.ts";
import { AdminRoutes } from "./routes/admin.ts";
import { UploadRoutes } from "./routes/uploads.ts";
import { DocsRoutes } from "./routes/docs.ts";

// Import KV factory
import {
  createKvFromEnv,
  getKvConfig,
  validateKvConfig,
} from "./utils/kv-factory.ts";

// Import authentication middleware
import {
  apiCors,
  optionalAuth,
  rateLimit,
  requireAdmin,
  requireAuth,
} from "./middleware/auth.ts";

// Import Hocuspocus extension
import { DenoKvExtension } from "./extensions/deno-kv.ts";

// Import session middleware
import type { SessionMiddleware } from "./middleware/session.ts";

// Bootstrap state tracking
let bootstrapInProgress = false;
let bootstrapCompleted = false;
let serverInstance: AbracadabraServer | null = null;

class AbracadabraServer {
  private app: Hono;
  private kv!: Deno.Kv;
  private config!: ServerConfig;
  private hocuspocus!: Hocuspocus;
  private logger!: ReturnType<typeof getLogger>;
  private isStarted = false;
  private isStarting = false;

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
    // Prevent multiple starts
    if (this.isStarted) {
      console.warn(
        "[Server] Server already started, ignoring duplicate start request",
      );
      return;
    }

    if (this.isStarting) {
      console.warn(
        "[Server] Server start already in progress, ignoring duplicate start request",
      );
      return;
    }

    this.isStarting = true;
    const isDeployEnv = isDenoDeploy();
    const envInfo = getEnvironmentInfo();
    const startTime = Date.now();

    try {
      // Initialize logging first (without config service)
      await createLoggingService();
      this.logger = getLogger(["main"]);

      this.logger.info("🎩 Starting Abracadabra Server...", {
        isDeployEnv,
        startTime: new Date().toISOString(),
      });

      // 1. Initialize core services with timeout protection
      this.logger.info("Initializing core services...");
      const servicesPromise = this.initializeServices();

      if (isDeployEnv) {
        await Promise.race([
          servicesPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Service initialization timeout")),
              30000,
            ),
          ),
        ]);
      } else {
        await servicesPromise;
      }

      // 2. Setup middleware
      this.logger.info("Setting up middleware...");
      this.setupMiddleware();

      // 3. Setup routes
      this.logger.info("Setting up routes...");
      this.setupRoutes();

      // 4. Initialize real-time collaboration with timeout protection
      this.logger.info("Initializing real-time collaboration...");
      const collaborationPromise = this.initializeCollaboration();

      if (isDeployEnv) {
        await Promise.race([
          collaborationPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Collaboration initialization timeout")),
              20000,
            ),
          ),
        ]);
      } else {
        await collaborationPromise;
      }

      // 5. Start HTTP server
      this.logger.info("Starting HTTP server...");
      await this.startHttpServer();

      const totalStartTime = Date.now() - startTime;
      this.logger.info("🚀 Abracadabra Server started successfully!", {
        totalStartTime: `${totalStartTime}ms`,
        environment: envInfo.platform,
        port: this.config?.server?.port || 8000,
      });

      this.isStarted = true;
      this.isStarting = false;
    } catch (error) {
      const totalStartTime = Date.now() - startTime;
      this.logger.error("Failed to start Abracadabra Server", {
        error: (error as Error).message,
        stack: (error as Error).stack?.split("\n").slice(0, 3).join("\n"),
        totalStartTime: `${totalStartTime}ms`,
        isDeployEnv,
      });

      // Attempt cleanup with timeout protection
      try {
        if (isDeployEnv) {
          await Promise.race([
            this.cleanup(),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
        } else {
          await this.cleanup();
        }
      } catch (cleanupError) {
        this.logger.error("Cleanup failed during error handling", {
          cleanupError: (cleanupError as Error).message,
        });
      }

      // Re-throw the original error
      this.isStarting = false;
      throw error;
    }
  }

  /**
   * Initialize core services (Config, Logging, Database)
   */
  private async initializeServices(): Promise<void> {
    this.logger.info("Initializing core services...");

    // Validate KV configuration
    const kvConfigValidation = validateKvConfig();
    if (!kvConfigValidation.valid) {
      throw new Error(
        `Invalid KV configuration: ${kvConfigValidation.errors.join(", ")}`,
      );
    }

    // Initialize KV store (Deno KV or PostgreSQL)
    const kvConfig = getKvConfig();
    this.kv = await createKvFromEnv();
    this.logger.info(
      `KV store initialized using ${kvConfig.provider} provider`,
      {
        provider: kvConfig.provider,
        ...(kvConfig.provider === "deno" && { path: kvConfig.denoKvPath }),
        ...(kvConfig.provider === "postgres" && {
          hasUrl: !!kvConfig.postgresUrl,
        }),
      },
    );

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

    // CORS middleware - exclude WebSocket routes
    this.app.use(
      "/api/*",
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

    // CORS for non-API routes (excluding WebSocket routes)
    this.app.use(
      "/health",
      cors({
        origin: "*",
        allowMethods: ["GET", "OPTIONS"],
        allowHeaders: ["Content-Type"],
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

    // Normalize trailing slashes middleware
    this.app.use("/api/*", async (c, next) => {
      const url = new URL(c.req.url);
      if (url.pathname.endsWith("/") && url.pathname.length > 1) {
        const newPath = url.pathname.slice(0, -1);
        url.pathname = newPath;
        return c.redirect(url.toString(), 301);
      }
      await next();
    });

    // Session middleware
    this.app.use("*", async (c, next) => {
      // Skip session middleware for WebSocket routes to prevent header conflicts
      if (
        c.req.path === "/collaborate" ||
        c.req.path === "/ws" ||
        c.req.path.startsWith("/collaborate/")
      ) {
        return next();
      }
      return this.sessionMiddleware.handle()(c, next);
    });

    // Rate limiting middleware (TEMPORARILY DISABLED FOR DEBUGGING)
    // this.app.use(
    //   "/api/*",
    //   rateLimit({
    //     windowMs: 15 * 60 * 1000, // 15 minutes
    //     maxRequests: 1000, // limit each IP to 1000 requests per windowMs
    //   }),
    // );

    // API CORS middleware (TEMPORARILY DISABLED FOR DEBUGGING)
    // this.app.use(
    //   "/api/*",
    //   apiCors({
    //     allowedOrigins: ["*"], // Configure in production
    //     allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    //     allowedHeaders: ["Content-Type", "Authorization", "X-Session-Token"],
    //   }),
    // );

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

    // Rate limiting for WebSocket connections
    const connectionAttempts = new Map<string, number[]>();
    const ipConnectionAttempts = new Map<string, number[]>();
    const RATE_LIMIT_WINDOW = 30000; // 30 seconds
    const MAX_CONNECTIONS_PER_WINDOW = 3; // Much more strict
    const MAX_IP_CONNECTIONS_PER_WINDOW = 5; // IP-based limit

    // Circuit breaker to completely stop WebSocket spam
    let circuitBreakerTripped = false;
    let circuitBreakerTrippedAt = 0;
    let rateLimitHits = 0;
    const CIRCUIT_BREAKER_THRESHOLD = 20; // Trip after 20 rate limit hits
    const CIRCUIT_BREAKER_RESET_TIME = 300000; // 5 minutes
    const CIRCUIT_BREAKER_WINDOW = 60000; // Count hits in 1 minute window

    const isRateLimited = (identifier: string): boolean => {
      const now = Date.now();
      const attempts = connectionAttempts.get(identifier) || [];

      // Clean old attempts
      const recentAttempts = attempts.filter(
        (time) => now - time < RATE_LIMIT_WINDOW,
      );
      connectionAttempts.set(identifier, recentAttempts);

      // Check if rate limited
      if (recentAttempts.length >= MAX_CONNECTIONS_PER_WINDOW) {
        return true;
      }

      // Add current attempt
      recentAttempts.push(now);
      connectionAttempts.set(identifier, recentAttempts);
      return false;
    };

    const isIpRateLimited = (ip: string): boolean => {
      const now = Date.now();
      const attempts = ipConnectionAttempts.get(ip) || [];

      // Clean old attempts
      const recentAttempts = attempts.filter(
        (time) => now - time < RATE_LIMIT_WINDOW,
      );
      ipConnectionAttempts.set(ip, recentAttempts);

      // Check if rate limited
      if (recentAttempts.length >= MAX_IP_CONNECTIONS_PER_WINDOW) {
        return true;
      }

      // Add current attempt
      recentAttempts.push(now);
      ipConnectionAttempts.set(ip, recentAttempts);
      return false;
    };

    const extractClientIp = (data: any): string => {
      // Try to extract IP from various sources
      const connection = data.connection;
      if (connection?.socket?.remoteAddress) {
        return connection.socket.remoteAddress;
      }
      if (connection?.request?.socket?.remoteAddress) {
        return connection.request.socket.remoteAddress;
      }
      if (connection?.request?.connection?.remoteAddress) {
        return connection.request.connection.remoteAddress;
      }
      // Fallback to "unknown"
      return "unknown";
    };

    const checkCircuitBreaker = (): boolean => {
      const now = Date.now();

      // Reset circuit breaker after timeout
      if (
        circuitBreakerTripped &&
        now - circuitBreakerTrippedAt > CIRCUIT_BREAKER_RESET_TIME
      ) {
        circuitBreakerTripped = false;
        rateLimitHits = 0;
        collaborationLogger.info(
          "Circuit breaker reset - WebSocket connections enabled again",
        );
      }

      return circuitBreakerTripped;
    };

    const tripCircuitBreaker = (): void => {
      rateLimitHits++;

      if (rateLimitHits >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerTripped = true;
        circuitBreakerTrippedAt = Date.now();
        collaborationLogger.error(
          "Circuit breaker TRIPPED - WebSocket connections disabled for 5 minutes",
          {
            rateLimitHits,
            threshold: CIRCUIT_BREAKER_THRESHOLD,
          },
        );
      }
    };

    // Initialize Deno KV extension
    const denoKvExtension = new DenoKvExtension(this.kv, {
      debounceInterval: 2000,
      maxRetries: 3,
      enableMetrics: true,
    });

    // Capture logger for callback scope
    const collaborationLogger = this.logger;

    // Initialize Hocuspocus server
    this.hocuspocus = new Hocuspocus({
      name: "abracadabra-collaboration",

      async onAuthenticate(data: any) {
        // Check circuit breaker first
        if (checkCircuitBreaker()) {
          collaborationLogger.warn(
            "Circuit breaker active - REJECTING all WebSocket connections",
            {
              documentName: data.documentName,
              rateLimitHits,
              trippedAt: new Date(circuitBreakerTrippedAt).toISOString(),
            },
          );
          throw new Error(
            "Circuit breaker active - service temporarily unavailable",
          );
        }

        // Extract client IP for rate limiting
        const clientIp = extractClientIp(data);

        // Rate limiting by IP address to prevent spam attacks
        if (isIpRateLimited(clientIp)) {
          tripCircuitBreaker();
          collaborationLogger.warn(
            "WebSocket connection IP rate limited - REJECTING",
            {
              documentName: data.documentName,
              clientIp,
              rateLimitHits,
            },
          );
          throw new Error("IP rate limited");
        }

        // Rate limiting by document name to prevent spam
        const identifier = `${data.documentName || "unknown"}`;

        if (isRateLimited(identifier)) {
          tripCircuitBreaker();
          collaborationLogger.warn(
            "WebSocket connection rate limited - REJECTING",
            {
              documentName: data.documentName,
              identifier,
              clientIp,
              rateLimitHits,
            },
          );
          throw new Error("Rate limited");
        }

        collaborationLogger.info("WebSocket authentication request", {
          documentName: data.documentName,
          hasToken: !!data.token,
          clientIp,
        });

        // Basic validation - require token and document name
        if (!data.token || !data.documentName) {
          collaborationLogger.warn(
            "WebSocket authentication failed: missing token or document name",
            {
              documentName: data.documentName,
              hasToken: !!data.token,
            },
          );
          return false;
        }

        // Validate token format (basic check)
        if (typeof data.token !== "string" || data.token.length < 10) {
          collaborationLogger.warn(
            "WebSocket authentication failed: invalid token format",
            {
              documentName: data.documentName,
              tokenLength: data.token?.length || 0,
            },
          );
          return false;
        }

        // TODO: Add proper session validation here
        // For now, accept any properly formatted token
        return true;
      },

      async onConnect(data: any) {
        collaborationLogger.info("WebSocket connection established", {
          documentName: data.documentName,
          connectionId: data.connection?.id,
        });

        // Add connection limit per document (max 5 concurrent connections)
        const connectionCount = this.hocuspocus?.getConnectionsCount() || 0;
        if (connectionCount > 20) {
          collaborationLogger.warn("Connection limit exceeded - REJECTING", {
            documentName: data.documentName,
            connectionCount,
          });
          throw new Error("Connection limit exceeded");
        }

        return true;
      },

      extensions: [denoKvExtension],

      async onStoreDocument(data: any) {
        collaborationLogger.info("Document state stored", {
          documentName: data.documentName,
          size: Y.encodeStateAsUpdate(data.document).length,
        });
      },

      async onChange(data: any) {
        collaborationLogger.debug("Document changed", {
          documentName: data.documentName,
          clientsCount: data.clientsCount,
        });
      },
    });

    // Setup WebSocket routes with proper error handling
    this.setupWebSocketRoutes();

    this.logger.info("Real-time collaboration initialized");
  }

  /**
   * Setup WebSocket routes
   */
  private setupWebSocketRoutes(): void {
    this.logger.info("Setting up WebSocket routes...");

    // Test WebSocket endpoint
    this.app.get(
      "/ws",
      upgradeWebSocket(() => {
        const logger = this.logger; // Capture logger for callback
        return {
          onOpen: () => {
            logger.info("Test WebSocket connection opened");
          },
          onMessage: (event, ws) => {
            logger.debug("Test WebSocket message", { data: event.data });
            ws.send(`Echo: ${event.data}`);
          },
          onClose: () => {
            logger.info("Test WebSocket connection closed");
          },
          onError: (error) => {
            logger.error("Test WebSocket error", { error });
          },
        };
      }),
    );

    // Collaboration WebSocket endpoint
    this.app.get(
      "/collaborate",
      upgradeWebSocket((c) => {
        const logger = this.logger;
        const hocuspocusServer = this.hocuspocus;

        return {
          onOpen: (event, ws) => {
            logger.info("Collaboration WebSocket connection opened");

            // Apply Deno WebSocket polyfill and handle connection with Hocuspocus
            if (ws.raw) {
              const polyfilliedWS = ensureNodeJSMethods(ws.raw);
              hocuspocusServer.handleConnection(
                polyfilliedWS,
                c.req.raw as any,
              );
            }
          },
        };
      }),
    );

    // Document-specific collaboration endpoint
    this.app.get(
      "/collaborate/:documentId",
      upgradeWebSocket((c) => {
        const documentId = c.req.param("documentId");
        const logger = this.logger; // Capture logger for callback

        return {
          onOpen: () => {
            logger.info("Document collaboration connection opened", {
              documentId,
            });
          },
          onMessage: (event, ws) => {
            try {
              logger.debug("Document collaboration message", {
                documentId,
                dataType: typeof event.data,
              });

              // Process document-specific collaboration
              ws.send(
                JSON.stringify({
                  type: "document_ack",
                  documentId,
                  timestamp: Date.now(),
                }),
              );
            } catch (error) {
              logger.error("Error in document collaboration", {
                documentId,
                error: (error as Error).message,
              });
            }
          },
          onClose: () => {
            logger.info("Document collaboration connection closed", {
              documentId,
            });
          },
          onError: (error) => {
            logger.error("Document collaboration error", {
              documentId,
              error: error.message || error,
            });
          },
        };
      }),
    );

    this.logger.info("WebSocket routes configured successfully", {
      endpoints: ["/ws", "/collaborate", "/collaborate/:documentId"],
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
      // Close Hocuspocus server
      if (this.hocuspocus) {
        await this.hocuspocus.destroy();
        this.logger.info("Hocuspocus server closed");
      }

      // Close KV store
      if (this.kv) {
        this.kv.close();
        this.logger.info("KV store connection closed");
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

/**
 * Enhanced bootstrap function with Deno Deploy safeguards
 */
async function bootstrap(): Promise<void> {
  // Prevent multiple bootstrap attempts
  if (bootstrapInProgress) {
    console.warn(
      "[Bootstrap] Bootstrap already in progress, ignoring duplicate call",
    );
    return;
  }

  if (bootstrapCompleted) {
    console.warn(
      "[Bootstrap] Bootstrap already completed, ignoring duplicate call",
    );
    return;
  }

  bootstrapInProgress = true;
  const envInfo = getEnvironmentInfo();
  const isDeployEnv = envInfo.isDenoDeploy;
  const deployId = getDeploymentId();
  const startTime = Date.now();

  const logPrefix = getLoggerPrefix();
  const mainLogger = {
    info: (msg: string, extra?: any) => {
      console.info(`[INFO] ${logPrefix} bootstrap: ${msg}`, extra || {});
    },
    error: (msg: string, extra?: any) => {
      console.error(`[ERROR] ${logPrefix} bootstrap: ${msg}`, extra || {});
    },
    warn: (msg: string, extra?: any) => {
      console.warn(`[WARN] ${logPrefix} bootstrap: ${msg}`, extra || {});
    },
  };

  try {
    mainLogger.info("🎩 Bootstrapping Abracadabra Server...", {
      environment: envInfo,
      denoVersion: Deno.version.deno,
    });

    // Environment-specific permission checks
    if (!isDeployEnv) {
      // Only check permissions in local development
      try {
        const status = await Deno.permissions.query({ name: "net" });
        if (status.state !== "granted") {
          throw new Error(
            "Network permission required. Run with --allow-net flag.",
          );
        }
        mainLogger.info("Permissions verified for local development");
      } catch (permError) {
        mainLogger.warn("Permission check failed, proceeding anyway", {
          error: (permError as Error).message,
        });
      }
    } else {
      mainLogger.info("Running on Deno Deploy, skipping permission checks", {
        deploymentId: envInfo.deploymentId,
        region: envInfo.region,
      });
    }

    // Environment validation
    const requiredEnvVars = envInfo.isDenoDeploy ? [] : ["KV_PROVIDER"]; // Less strict on Deploy
    const missingEnvVars = requiredEnvVars.filter(
      (envVar) => !Deno.env.get(envVar),
    );

    if (missingEnvVars.length > 0) {
      mainLogger.warn("Some environment variables are missing", {
        missing: missingEnvVars,
        isDeployEnv,
      });
    }

    // Set production environment for Deploy
    if (envInfo.isDenoDeploy && !Deno.env.get("NODE_ENV")) {
      Deno.env.set("NODE_ENV", "production");
      mainLogger.info("Set NODE_ENV=production for Deno Deploy");
    }

    // Create and start server with timeout protection (singleton)
    if (!serverInstance) {
      serverInstance = new AbracadabraServer();
    }
    const server = serverInstance;

    if (envInfo.isDenoDeploy) {
      // Add startup timeout for Deno Deploy
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Server startup timeout (45s)")),
          45000,
        ),
      );

      await Promise.race([server.start(), timeoutPromise]);
    } else {
      await server.start();
    }

    const startupTime = Date.now() - startTime;
    mainLogger.info("🚀 Abracadabra Server bootstrap completed successfully!", {
      startupTime: `${startupTime}ms`,
      environment: envInfo.platform,
      deployId,
    });

    bootstrapCompleted = true;
    bootstrapInProgress = false;
  } catch (error) {
    const startupTime = Date.now() - startTime;
    const errorDetails = {
      error: (error as Error).message,
      stack: (error as Error).stack?.split("\n").slice(0, 5).join("\n"),
      startupTime: `${startupTime}ms`,
      environment: envInfo.platform,
      deployId,
      timestamp: new Date().toISOString(),
    };

    mainLogger.error("Failed to bootstrap server", errorDetails);

    // Enhanced error reporting for Deno Deploy
    if (envInfo.isDenoDeploy) {
      // Log additional context for Deploy debugging
      mainLogger.error("Deno Deploy diagnostic info", {
        deploymentId: envInfo.deploymentId,
        region: envInfo.region,
        runtime: "deno-deploy",
        kvProvider: Deno.env.get("KV_PROVIDER"),
        hasPostgresUrl: !!(
          Deno.env.get("DATABASE_URL") || Deno.env.get("POSTGRES_URL")
        ),
      });
    }

    // In development, we might want to exit, but on Deploy we should let it retry
    if (!envInfo.isDenoDeploy) {
      mainLogger.error("Exiting due to bootstrap failure in development");
      // Deno.exit(1); // Uncomment if needed for local development
    } else {
      mainLogger.error(
        "Bootstrap failed on Deno Deploy, letting platform handle retry",
      );
    }

    bootstrapInProgress = false;
    throw error; // Re-throw to let Deno Deploy handle the failure
  }
}

// Start the application
if (import.meta.main) {
  bootstrap();
}

export { AbracadabraServer };
