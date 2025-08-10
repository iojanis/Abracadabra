// Documentation Routes for Abracadabra Server
// Serves OpenAPI specification and Swagger UI

import { Hono } from "hono";
import { getOpenAPIService } from "../services/openapi.ts";

export class DocsRoutes {
  private app: Hono;

  constructor() {
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Root documentation endpoint - redirect to Swagger UI
    this.app.get("/", async (c) => {
      return c.redirect("/api/docs/ui");
    });

    // Swagger UI interface
    this.app.get("/ui", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const swaggerHTML = openApiService.getSwaggerUI(
          "/api/docs/openapi.json",
        );

        c.header("Content-Type", "text/html; charset=utf-8");
        return c.body(swaggerHTML);
      } catch (error) {
        return c.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Documentation service not available",
            },
          },
          503,
        );
      }
    });

    // OpenAPI specification in JSON format
    this.app.get("/openapi.json", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const spec = openApiService.getSpecJSON();

        c.header("Content-Type", "application/json; charset=utf-8");
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Cache-Control", "public, max-age=300"); // Cache for 5 minutes

        return c.body(spec);
      } catch (error) {
        return c.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "OpenAPI specification not available",
            },
          },
          503,
        );
      }
    });

    // OpenAPI specification in YAML format
    this.app.get("/openapi.yaml", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const spec = openApiService.getSpecYAML();

        c.header("Content-Type", "text/yaml; charset=utf-8");
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Cache-Control", "public, max-age=300");

        return c.body(spec);
      } catch (error) {
        return c.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "OpenAPI specification not available",
            },
          },
          503,
        );
      }
    });

    // Alternative OpenAPI endpoints for compatibility
    this.app.get("/spec.json", async (c) => {
      return c.redirect("/api/docs/openapi.json");
    });

    this.app.get("/spec.yaml", async (c) => {
      return c.redirect("/api/docs/openapi.yaml");
    });

    this.app.get("/swagger.json", async (c) => {
      return c.redirect("/api/docs/openapi.json");
    });

    // API information endpoint
    this.app.get("/info", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const spec = openApiService.getSpec();

        return c.json({
          success: true,
          data: {
            title: spec.info.title,
            description: spec.info.description,
            version: spec.info.version,
            contact: spec.info.contact,
            license: spec.info.license,
            servers: spec.servers,
            endpoints: {
              openapi_json: "/api/docs/openapi.json",
              openapi_yaml: "/api/docs/openapi.yaml",
              swagger_ui: "/api/docs/ui",
              redoc_ui: "/api/docs/redoc", // Future implementation
            },
            statistics: {
              total_paths: Object.keys(spec.paths).length,
              total_schemas: Object.keys(spec.components.schemas || {}).length,
              security_schemes: Object.keys(
                spec.components.securitySchemes || {},
              ).length,
            },
          },
        });
      } catch (error) {
        return c.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "API information not available",
            },
          },
          503,
        );
      }
    });

    // ReDoc interface (alternative to Swagger UI)
    this.app.get("/redoc", async (c) => {
      const redocHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Abracadabra Server API Documentation - ReDoc" />
  <title>Abracadabra API Documentation - ReDoc</title>
  <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init('/api/docs/openapi.json', {
      scrollYOffset: 0,
      hideDownloadButton: false,
      disableSearch: false,
      expandResponses: "200,201",
      requiredPropsFirst: true,
      sortPropsAlphabetically: true,
      showExtensions: true,
      pathInMiddlePanel: true,
      hideHostname: false,
      hideLoading: false,
      nativeScrollbars: false,
      theme: {
        colors: {
          primary: {
            main: '#32329f'
          }
        },
        typography: {
          fontSize: '14px',
          lineHeight: '1.5em',
          code: {
            fontSize: '13px'
          },
          headings: {
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: '400'
          }
        },
        sidebar: {
          backgroundColor: '#fafafa'
        }
      }
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(redocHTML);
    });

    // Health check for documentation service
    this.app.get("/health", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const spec = openApiService.getSpec();

        return c.json({
          success: true,
          status: "healthy",
          service: "documentation",
          timestamp: new Date().toISOString(),
          version: spec.info.version,
          endpoints_available: [
            "/api/docs/ui",
            "/api/docs/redoc",
            "/api/docs/openapi.json",
            "/api/docs/openapi.yaml",
            "/api/docs/info",
          ],
        });
      } catch (error) {
        return c.json(
          {
            success: false,
            status: "unhealthy",
            service: "documentation",
            error: "OpenAPI service not available",
            timestamp: new Date().toISOString(),
          },
          503,
        );
      }
    });

    // Postman collection export
    this.app.get("/postman", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const spec = openApiService.getSpec();

        // Basic Postman collection structure
        const postmanCollection = {
          info: {
            name: spec.info.title,
            description: spec.info.description,
            version: spec.info.version,
            schema:
              "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
          },
          item: this.convertOpenAPIToPostman(spec),
          variable: [
            {
              key: "baseUrl",
              value: spec.servers[0]?.url || "http://localhost:8787",
              type: "string",
            },
          ],
        };

        c.header("Content-Type", "application/json");
        c.header(
          "Content-Disposition",
          'attachment; filename="abracadabra-api.postman_collection.json"',
        );

        return c.json(postmanCollection);
      } catch (error) {
        return c.json(
          {
            error: {
              code: "EXPORT_FAILED",
              message: "Failed to generate Postman collection",
            },
          },
          500,
        );
      }
    });

    // API status and statistics
    this.app.get("/stats", async (c) => {
      try {
        const openApiService = getOpenAPIService();
        const spec = openApiService.getSpec();

        const stats = {
          api: {
            title: spec.info.title,
            version: spec.info.version,
            openapi_version: spec.openapi,
          },
          endpoints: {
            total: Object.keys(spec.paths).length,
            by_method: this.getEndpointsByMethod(spec.paths),
            by_tag: this.getEndpointsByTag(spec.paths),
          },
          schemas: {
            total: Object.keys(spec.components.schemas || {}).length,
            list: Object.keys(spec.components.schemas || {}),
          },
          security: {
            schemes: Object.keys(spec.components.securitySchemes || {}),
            global_security: spec.security || [],
          },
          servers: spec.servers.length,
        };

        return c.json({
          success: true,
          data: stats,
          generated_at: new Date().toISOString(),
        });
      } catch (error) {
        return c.json(
          {
            error: {
              code: "STATS_UNAVAILABLE",
              message: "API statistics not available",
            },
          },
          503,
        );
      }
    });
  }

  /**
   * Convert OpenAPI spec to basic Postman collection format
   */
  private convertOpenAPIToPostman(spec: any): any[] {
    const items: any[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem as any)) {
        if (
          typeof operation === "object" &&
          operation !== null &&
          (operation as any).operationId
        ) {
          const op = operation as any;
          items.push({
            name: op.summary || op.operationId,
            request: {
              method: method.toUpperCase(),
              header: [],
              url: {
                raw: `{{baseUrl}}${path}`,
                host: ["{{baseUrl}}"],
                path: path.split("/").filter(Boolean),
              },
              description: op.description,
            },
            response: [],
          });
        }
      }
    }

    return items;
  }

  /**
   * Get endpoint statistics by HTTP method
   */
  private getEndpointsByMethod(paths: any): Record<string, number> {
    const stats: Record<string, number> = {};

    for (const pathItem of Object.values(paths)) {
      for (const method of Object.keys(pathItem as any)) {
        if (
          ["get", "post", "put", "delete", "patch", "head", "options"].includes(
            method,
          )
        ) {
          stats[method.toUpperCase()] = (stats[method.toUpperCase()] || 0) + 1;
        }
      }
    }

    return stats;
  }

  /**
   * Get endpoint statistics by tag
   */
  private getEndpointsByTag(paths: any): Record<string, number> {
    const stats: Record<string, number> = {};

    for (const pathItem of Object.values(paths)) {
      for (const operation of Object.values(pathItem as any)) {
        if (
          typeof operation === "object" &&
          operation !== null &&
          (operation as any).tags
        ) {
          const op = operation as any;
          for (const tag of op.tags) {
            stats[tag] = (stats[tag] || 0) + 1;
          }
        }
      }
    }

    return stats;
  }

  getApp(): Hono {
    return this.app;
  }
}

export default DocsRoutes;
