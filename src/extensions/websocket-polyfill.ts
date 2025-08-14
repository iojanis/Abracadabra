/**
 * WebSocket polyfill for Hocuspocus compatibility with Deno
 *
 * Hocuspocus expects Node.js-style WebSocket with .on, .off, .once methods,
 * but Deno WebSocket only provides addEventListener/removeEventListener.
 * This polyfill adds the missing methods to make them compatible.
 *
 * Includes Deno Deploy safeguards and enhanced error handling.
 */

/**
 * Detect if running on Deno Deploy
 */
function isDenoDeploy(): boolean {
  return Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
}

// Enhanced logger with Deno Deploy detection
const logger = {
  debug: (message: string, extra?: any) => {
    const deployId = isDenoDeploy()
      ? `[Deploy:${Deno.env.get("DENO_DEPLOYMENT_ID")?.slice(0, 8)}] `
      : "";
    console.debug(
      `[DEBUG] ${deployId}websocket-polyfill: ${message}`,
      extra || {},
    );
  },
  info: (message: string, extra?: any) => {
    const deployId = isDenoDeploy()
      ? `[Deploy:${Deno.env.get("DENO_DEPLOYMENT_ID")?.slice(0, 8)}] `
      : "";
    console.info(
      `[INFO] ${deployId}websocket-polyfill: ${message}`,
      extra || {},
    );
  },
  warn: (message: string, extra?: any) => {
    const deployId = isDenoDeploy()
      ? `[Deploy:${Deno.env.get("DENO_DEPLOYMENT_ID")?.slice(0, 8)}] `
      : "";
    console.warn(
      `[WARN] ${deployId}websocket-polyfill: ${message}`,
      extra || {},
    );
  },
  error: (message: string, extra?: any) => {
    const deployId = isDenoDeploy()
      ? `[Deploy:${Deno.env.get("DENO_DEPLOYMENT_ID")?.slice(0, 8)}] `
      : "";
    console.error(
      `[ERROR] ${deployId}websocket-polyfill: ${message}`,
      extra || {},
    );
  },
};

export interface PolyfilliedWebSocket extends WebSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
}

/**
 * Apply Node.js-style event methods to a Deno WebSocket with Deno Deploy safeguards
 */
export function polyfillWebSocket(ws: WebSocket): PolyfilliedWebSocket {
  const polyfilliedWs = ws as PolyfilliedWebSocket;
  const isDeployEnv = isDenoDeploy();

  // Store listeners for proper removal
  const listenerMap = new WeakMap<Function, EventListener>();

  // Track polyfill health for debugging
  let polyfillHealthy = true;
  const polyfillStartTime = Date.now();

  // Add .on() method - maps to addEventListener with enhanced error handling
  if (!polyfilliedWs.on) {
    polyfilliedWs.on = function (
      event: string,
      listener: (...args: any[]) => void,
    ) {
      const eventListener = (evt: Event) => {
        try {
          if (!polyfillHealthy) {
            logger.warn("Polyfill unhealthy, skipping event", { event });
            return;
          }

          // Convert DOM event to Node.js-style parameters with timeout protection
          const handleEvent = () => {
            if (event === "message") {
              const messageEvent = evt as MessageEvent;
              listener(messageEvent.data);
            } else if (event === "close") {
              const closeEvent = evt as CloseEvent;
              listener(closeEvent.code, closeEvent.reason);
            } else if (event === "error") {
              const errorEvent = evt as ErrorEvent;
              listener(errorEvent.error || new Error(errorEvent.message));
            } else {
              listener(evt);
            }
          };

          // Add timeout protection for Deno Deploy
          if (isDeployEnv) {
            const timeoutId = setTimeout(() => {
              logger.warn("WebSocket event handler timeout", { event });
            }, 5000);

            try {
              handleEvent();
            } finally {
              clearTimeout(timeoutId);
            }
          } else {
            handleEvent();
          }
        } catch (error) {
          polyfillHealthy = false;
          logger.error("Error in WebSocket event listener", {
            event,
            error: (error as Error).message,
            isDeployEnv,
            polyfillAge: Date.now() - polyfillStartTime,
          });

          // Attempt to recover after a delay
          setTimeout(() => {
            polyfillHealthy = true;
            logger.info("Polyfill health recovered", { event });
          }, 1000);
        }
      };

      // Store the mapping for later removal
      listenerMap.set(listener, eventListener);

      try {
        this.addEventListener(event, eventListener);
        logger.debug("WebSocket listener added", { event, isDeployEnv });
      } catch (error) {
        logger.error("Failed to add WebSocket listener", {
          event,
          error: (error as Error).message,
        });
        throw error;
      }
    };
  }

  // Add .off() method - maps to removeEventListener with enhanced error handling
  if (!polyfilliedWs.off) {
    polyfilliedWs.off = function (
      event: string,
      listener: (...args: any[]) => void,
    ) {
      try {
        const eventListener = listenerMap.get(listener);
        if (eventListener) {
          this.removeEventListener(event, eventListener);
          listenerMap.delete(listener);
          logger.debug("WebSocket listener removed", { event, isDeployEnv });
        } else {
          logger.warn("Attempted to remove non-existent WebSocket listener", {
            event,
            isDeployEnv,
          });
        }
      } catch (error) {
        logger.error("Failed to remove WebSocket listener", {
          event,
          error: (error as Error).message,
          isDeployEnv,
        });
      }
    };
  }

  // Add .once() method - addEventListener with auto-removal and timeout protection
  if (!polyfilliedWs.once) {
    polyfilliedWs.once = function (
      event: string,
      listener: (...args: any[]) => void,
    ) {
      let executed = false;
      const startTime = Date.now();

      const wrappedListener = (...args: any[]) => {
        if (executed) {
          logger.warn("Once listener already executed, ignoring", { event });
          return;
        }
        executed = true;

        try {
          // Add timeout protection for Deno Deploy
          if (isDeployEnv) {
            const timeoutId = setTimeout(() => {
              logger.warn("WebSocket once handler timeout", { event });
            }, 3000);

            try {
              listener(...args);
            } finally {
              clearTimeout(timeoutId);
            }
          } else {
            listener(...args);
          }
        } catch (error) {
          logger.error("Error in WebSocket once listener", {
            event,
            error: (error as Error).message,
            isDeployEnv,
            executionTime: Date.now() - startTime,
          });
        } finally {
          // Clean up the listener after it fires
          try {
            const eventListener = listenerMap.get(wrappedListener);
            if (eventListener) {
              this.removeEventListener(event, eventListener);
              listenerMap.delete(wrappedListener);
            }
          } catch (cleanupError) {
            logger.warn("Error during once listener cleanup", {
              event,
              error: (cleanupError as Error).message,
            });
          }
        }
      };

      // Use the regular .on() method which handles the event conversion
      try {
        this.on(event, wrappedListener);
        logger.debug("WebSocket once listener added", { event, isDeployEnv });
      } catch (error) {
        logger.error("Failed to add WebSocket once listener", {
          event,
          error: (error as Error).message,
        });
        throw error;
      }
    };
  }

  // Add additional Node.js-style methods that Hocuspocus might expect
  if (!("setMaxListeners" in polyfilliedWs)) {
    (polyfilliedWs as any).setMaxListeners = function (max: number) {
      // No-op for web WebSocket, just for compatibility
      logger.debug("setMaxListeners called (no-op in browser WebSocket)", {
        max,
      });
    };
  }

  if (!("getMaxListeners" in polyfilliedWs)) {
    (polyfilliedWs as any).getMaxListeners = function () {
      // Return a reasonable default
      return 10;
    };
  }

  if (!("listenerCount" in polyfilliedWs)) {
    (polyfilliedWs as any).listenerCount = function (event: string) {
      // Can't easily track this with addEventListener, return 0
      return 0;
    };
  }

  if (!("removeAllListeners" in polyfilliedWs)) {
    (polyfilliedWs as any).removeAllListeners = function (event?: string) {
      // Can't easily implement this with addEventListener, just log
      logger.debug("removeAllListeners called (limited support)", {
        event,
      });
    };
  }

  logger.debug("WebSocket polyfill applied successfully", {
    isDeployEnv,
    polyfillAge: Date.now() - polyfillStartTime,
    healthy: polyfillHealthy,
  });
  return polyfilliedWs;
}

/**
 * Type guard to check if WebSocket already has Node.js-style methods
 */
export function hasNodeJSMethods(ws: WebSocket): ws is PolyfilliedWebSocket {
  return (
    "on" in ws &&
    "off" in ws &&
    "once" in ws &&
    typeof (ws as any).on === "function" &&
    typeof (ws as any).off === "function" &&
    typeof (ws as any).once === "function"
  );
}

/**
 * Safely polyfill WebSocket only if it doesn't already have Node.js methods
 */
export function ensureNodeJSMethods(ws: WebSocket): PolyfilliedWebSocket {
  const isDeployEnv = isDenoDeploy();

  try {
    if (hasNodeJSMethods(ws)) {
      logger.debug("WebSocket already has Node.js methods, skipping polyfill", {
        isDeployEnv,
      });
      return ws;
    }

    logger.debug("Applying WebSocket polyfill for Node.js compatibility", {
      isDeployEnv,
    });
    return polyfillWebSocket(ws);
  } catch (error) {
    logger.error("Failed to ensure Node.js methods on WebSocket", {
      error: (error as Error).message,
      isDeployEnv,
    });
    throw error;
  }
}

/**
 * Test function to verify polyfill works correctly
 */
export function testPolyfill(ws: WebSocket): boolean {
  try {
    const polyfilled = ensureNodeJSMethods(ws);

    // Test that all required methods exist
    const requiredMethods = ["on", "off", "once"];
    for (const method of requiredMethods) {
      if (typeof (polyfilled as any)[method] !== "function") {
        logger.error("Polyfill test failed: missing method", { method });
        return false;
      }
    }

    logger.debug("WebSocket polyfill test passed");
    return true;
  } catch (error) {
    logger.error("WebSocket polyfill test failed", {
      error: (error as Error).message,
    });
    return false;
  }
}

/**
 * Utility to create a polyfilled WebSocket with enhanced error handling and Deno Deploy safeguards
 */
export function createPolyfilliedWebSocket(
  url: string,
  protocols?: string | string[],
): PolyfilliedWebSocket {
  const isDeployEnv = isDenoDeploy();
  const startTime = Date.now();

  try {
    logger.debug("Creating WebSocket connection", {
      url: url.replace(/\/\/.*@/, "//***@"), // Hide credentials
      protocols,
      isDeployEnv,
    });

    const ws = new WebSocket(url, protocols);

    // Add connection timeout for Deno Deploy
    if (isDeployEnv) {
      const timeoutId = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          logger.warn("WebSocket connection timeout", { url });
          ws.close();
        }
      }, 15000); // 15 second timeout

      ws.addEventListener("open", () => clearTimeout(timeoutId), {
        once: true,
      });
      ws.addEventListener("error", () => clearTimeout(timeoutId), {
        once: true,
      });
    }

    const polyfilled = ensureNodeJSMethods(ws);

    logger.debug("WebSocket created and polyfilled successfully", {
      isDeployEnv,
      creationTime: Date.now() - startTime,
    });

    return polyfilled;
  } catch (error) {
    logger.error("Failed to create WebSocket", {
      url: url.replace(/\/\/.*@/, "//***@"), // Hide credentials
      protocols,
      error: (error as Error).message,
      isDeployEnv,
      creationTime: Date.now() - startTime,
    });
    throw error;
  }
}

/**
 * Debug utility to log WebSocket events for troubleshooting with Deno Deploy enhancements
 */
export function addDebugListeners(
  ws: PolyfilliedWebSocket,
  identifier = "unknown",
): void {
  const isDeployEnv = isDenoDeploy();
  const startTime = Date.now();

  ws.on("open", () => {
    logger.debug("WebSocket opened", {
      identifier,
      isDeployEnv,
      connectionTime: Date.now() - startTime,
    });
  });

  ws.on("message", (data: any) => {
    logger.debug("WebSocket message received", {
      identifier,
      dataType: typeof data,
      dataLength: data?.length || 0,
      isDeployEnv,
    });
  });

  ws.on("close", (code: number, reason: string) => {
    logger.debug("WebSocket closed", {
      identifier,
      code,
      reason,
      isDeployEnv,
      totalLifetime: Date.now() - startTime,
    });
  });

  ws.on("error", (error: Error) => {
    logger.error("WebSocket error", {
      identifier,
      error: error.message,
      isDeployEnv,
      errorTime: Date.now() - startTime,
    });
  });
}
