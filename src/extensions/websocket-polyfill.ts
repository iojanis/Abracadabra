/**
 * WebSocket polyfill for Hocuspocus compatibility with Deno
 *
 * Hocuspocus expects Node.js-style WebSocket with .on, .off, .once methods,
 * but Deno WebSocket only provides addEventListener/removeEventListener.
 * This polyfill adds the missing methods to make them compatible.
 */

// Simple console-based logger to avoid circular dependencies
const logger = {
  debug: (message: string, extra?: any) => {
    console.debug(`[DEBUG] websocket-polyfill: ${message}`, extra || {});
  },
  info: (message: string, extra?: any) => {
    console.info(`[INFO] websocket-polyfill: ${message}`, extra || {});
  },
  warn: (message: string, extra?: any) => {
    console.warn(`[WARN] websocket-polyfill: ${message}`, extra || {});
  },
  error: (message: string, extra?: any) => {
    console.error(`[ERROR] websocket-polyfill: ${message}`, extra || {});
  },
};

export interface PolyfilliedWebSocket extends WebSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
}

/**
 * Apply Node.js-style event methods to a Deno WebSocket
 */
export function polyfillWebSocket(ws: WebSocket): PolyfilliedWebSocket {
  const polyfilliedWs = ws as PolyfilliedWebSocket;

  // Store listeners for proper removal
  const listenerMap = new WeakMap<Function, EventListener>();

  // Add .on() method - maps to addEventListener
  if (!polyfilliedWs.on) {
    polyfilliedWs.on = function (
      event: string,
      listener: (...args: any[]) => void,
    ) {
      const eventListener = (evt: Event) => {
        try {
          // Convert DOM event to Node.js-style parameters
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
        } catch (error) {
          logger.error("Error in WebSocket event listener", {
            event,
            error: (error as Error).message,
          });
        }
      };

      // Store the mapping for later removal
      listenerMap.set(listener, eventListener);

      this.addEventListener(event, eventListener);

      logger.debug("WebSocket listener added", { event });
    };
  }

  // Add .off() method - maps to removeEventListener
  if (!polyfilliedWs.off) {
    polyfilliedWs.off = function (
      event: string,
      listener: (...args: any[]) => void,
    ) {
      const eventListener = listenerMap.get(listener);
      if (eventListener) {
        this.removeEventListener(event, eventListener);
        listenerMap.delete(listener);
        logger.debug("WebSocket listener removed", { event });
      } else {
        logger.warn("Attempted to remove non-existent WebSocket listener", {
          event,
        });
      }
    };
  }

  // Add .once() method - addEventListener with auto-removal after first call
  if (!polyfilliedWs.once) {
    polyfilliedWs.once = function (
      event: string,
      listener: (...args: any[]) => void,
    ) {
      const wrappedListener = (...args: any[]) => {
        try {
          listener(...args);
        } catch (error) {
          logger.error("Error in WebSocket once listener", {
            event,
            error: (error as Error).message,
          });
        } finally {
          // Clean up the listener after it fires
          const eventListener = listenerMap.get(wrappedListener);
          if (eventListener) {
            this.removeEventListener(event, eventListener);
            listenerMap.delete(wrappedListener);
          }
        }
      };

      // Use the regular .on() method which handles the event conversion
      this.on(event, wrappedListener);

      logger.debug("WebSocket once listener added", { event });
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

  logger.debug("WebSocket polyfill applied successfully");
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
  if (hasNodeJSMethods(ws)) {
    logger.debug("WebSocket already has Node.js methods, skipping polyfill");
    return ws;
  }

  logger.debug("Applying WebSocket polyfill for Node.js compatibility");
  return polyfillWebSocket(ws);
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
 * Utility to create a polyfilled WebSocket with error handling
 */
export function createPolyfilliedWebSocket(
  url: string,
  protocols?: string | string[],
): PolyfilliedWebSocket {
  try {
    const ws = new WebSocket(url, protocols);
    return ensureNodeJSMethods(ws);
  } catch (error) {
    logger.error("Failed to create WebSocket", {
      url,
      protocols,
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Debug utility to log WebSocket events for troubleshooting
 */
export function addDebugListeners(
  ws: PolyfilliedWebSocket,
  identifier = "unknown",
): void {
  ws.on("open", () => {
    logger.debug("WebSocket opened", { identifier });
  });

  ws.on("message", (data: any) => {
    logger.debug("WebSocket message received", {
      identifier,
      dataType: typeof data,
      dataLength: data?.length || 0,
    });
  });

  ws.on("close", (code: number, reason: string) => {
    logger.debug("WebSocket closed", { identifier, code, reason });
  });

  ws.on("error", (error: Error) => {
    logger.error("WebSocket error", {
      identifier,
      error: error.message,
    });
  });
}
