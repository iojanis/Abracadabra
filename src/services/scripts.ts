// Server-Side Scripting Service for Abracadabra Server
// Handles secure execution of user scripts with sandboxed environment

import { getLogger } from "./logging.ts";
import type { ConfigService } from "./config.ts";
import type { DocumentService } from "./documents.ts";
import type { PermissionService } from "./permissions.ts";
import type { UserObject } from "../types/index.ts";

let logger: ReturnType<typeof getLogger> | null = null;

function getScriptLogger() {
  if (!logger) {
    logger = getLogger(["scripts"]);
  }
  return logger;
}

// Script execution context and interfaces
export interface ScriptContext {
  userId: string;
  documentPath: string;
  permissions: string[];
  timeout: number;
}

export interface ScriptResult {
  success: boolean;
  result?: any;
  error?: string;
  logs?: string[];
  executionTime?: number;
}

export interface ScriptAPI {
  // KV Operations
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;

  // HTTP Operations
  fetch(url: string, options?: RequestInit): Promise<Response>;

  // Document Operations
  updateDocument(path: string, updates: any): Promise<boolean>;
  getDocument(path: string): Promise<any>;

  // Utility functions
  log(message: string): void;
  getCurrentUser(): Promise<UserObject | null>;
}

export interface HookScriptObject {
  id: string;
  name: string;
  description?: string;
  script: string; // JavaScript/TypeScript code
  triggers: string[]; // Event types that trigger this script
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastExecuted?: Date;
  executionCount: number;
  errorCount: number;
}

export class ScriptRunner {
  private kv: Deno.Kv;
  private config: ConfigService;
  private documentService: DocumentService;
  private permissionService: PermissionService;
  private executionCache: Map<string, Worker> = new Map();

  constructor(
    kv: Deno.Kv,
    config: ConfigService,
    documentService: DocumentService,
    permissionService: PermissionService,
  ) {
    this.kv = kv;
    this.config = config;
    this.documentService = documentService;
    this.permissionService = permissionService;
  }

  /**
   * Execute a script in a sandboxed environment
   */
  async executeScript(
    script: string,
    context: ScriptContext,
  ): Promise<ScriptResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      getScriptLogger().info("Executing script", {
        userId: context.userId,
        documentPath: context.documentPath,
        scriptLength: script.length,
      });

      // Create sandboxed worker
      const worker = await this.createSandboxedWorker(script, context);

      // Set up communication
      const result = await this.executeInWorker(worker, context, logs);

      // Cleanup
      worker.terminate();

      const executionTime = Date.now() - startTime;

      getScriptLogger().info("Script executed successfully", {
        userId: context.userId,
        executionTime,
      });

      return {
        success: true,
        result: result.data,
        logs,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = (error as Error).message;

      getScriptLogger().error("Script execution failed", {
        userId: context.userId,
        error: errorMessage,
        executionTime,
      });

      return {
        success: false,
        error: errorMessage,
        logs,
        executionTime,
      };
    }
  }

  /**
   * Create a sandboxed worker for script execution
   */
  private async createSandboxedWorker(
    script: string,
    context: ScriptContext,
  ): Promise<Worker> {
    // Create worker script with sandbox restrictions
    const workerScript = `
      // Sandbox restrictions
      delete globalThis.Deno;
      delete globalThis.window;

      // Execution timeout
      const TIMEOUT = ${context.timeout || 30000};
      let timeoutId;

      // Logging function
      const logs = [];
      function log(message) {
        logs.push(\`[\${new Date().toISOString()}] \${message}\`);
        self.postMessage({ type: 'log', data: message });
      }

      // Safe API implementation
      const api = {
        get: async (key) => {
          const response = await self.postMessage({
            type: 'api_call',
            method: 'get',
            args: [key]
          });
          return response.data;
        },

        set: async (key, value) => {
          await self.postMessage({
            type: 'api_call',
            method: 'set',
            args: [key, value]
          });
        },

        fetch: async (url, options = {}) => {
          // Restrict to allowed domains
          if (!url.startsWith('https://')) {
            throw new Error('Only HTTPS URLs are allowed');
          }

          const response = await self.postMessage({
            type: 'api_call',
            method: 'fetch',
            args: [url, options]
          });
          return response.data;
        },

        updateDocument: async (path, updates) => {
          const response = await self.postMessage({
            type: 'api_call',
            method: 'updateDocument',
            args: [path, updates]
          });
          return response.data;
        },

        log: log,

        getCurrentUser: async () => {
          const response = await self.postMessage({
            type: 'api_call',
            method: 'getCurrentUser',
            args: []
          });
          return response.data;
        }
      };

      // Set up timeout
      timeoutId = setTimeout(() => {
        self.postMessage({ type: 'error', data: 'Script execution timeout' });
        self.close();
      }, TIMEOUT);

      // Execute user script
      try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const userFunction = new AsyncFunction('api', 'log', \`
          \${script}
        \`);

        const result = await userFunction(api, log);

        clearTimeout(timeoutId);
        self.postMessage({
          type: 'result',
          data: result,
          logs: logs
        });
      } catch (error) {
        clearTimeout(timeoutId);
        self.postMessage({
          type: 'error',
          data: error.message,
          logs: logs
        });
      }
    `;

    // Create worker from script
    const workerBlob = new Blob([workerScript], {
      type: "application/javascript",
    });
    const workerUrl = URL.createObjectURL(workerBlob);

    const worker = new Worker(workerUrl, {
      type: "module",
      deno: {
        permissions: "none", // No permissions for security
      },
    });

    return worker;
  }

  /**
   * Execute script in worker and handle communication
   */
  private async executeInWorker(
    worker: Worker,
    context: ScriptContext,
    logs: string[],
  ): Promise<{ data: any }> {
    return new Promise((resolve, reject) => {
      // Set up message handling
      worker.onmessage = async (e) => {
        await this.handleWorkerMessage(e.data, context, logs, resolve, reject);
      };

      worker.onerror = (error) => {
        reject(new Error(`Worker error: ${error.message}`));
      };

      // Start execution
      worker.postMessage({ type: "start" });
    });
  }

  /**
   * Handle messages from worker
   */
  private async handleWorkerMessage(
    message: any,
    context: ScriptContext,
    logs: string[],
    resolve: (value: any) => void,
    reject: (error: Error) => void,
  ): Promise<void> {
    try {
      switch (message.type) {
        case "log":
          logs.push(message.data);
          break;

        case "result":
          logs.push(...(message.logs || []));
          resolve({ data: message.data });
          break;

        case "error":
          logs.push(...(message.logs || []));
          reject(new Error(message.data));
          break;

        case "api_call":
          // Handle API calls from the sandboxed script
          const response = await this.handleAPICall(
            message.method,
            message.args,
            context,
          );
          // Send response back to worker (in a real implementation)
          // This would require a more complex communication protocol
          break;

        default:
          getScriptLogger().warn("Unknown worker message type", {
            type: message.type,
          });
      }
    } catch (error) {
      reject(error as Error);
    }
  }

  /**
   * Handle API calls from sandboxed scripts
   */
  private async handleAPICall(
    method: string,
    args: any[],
    context: ScriptContext,
  ): Promise<any> {
    switch (method) {
      case "get":
        return await this.handleGet(args[0], context);

      case "set":
        return await this.handleSet(args[0], args[1], context);

      case "fetch":
        return await this.handleFetch(args[0], args[1], context);

      case "updateDocument":
        return await this.handleUpdateDocument(args[0], args[1], context);

      case "getCurrentUser":
        return await this.handleGetCurrentUser(context);

      default:
        throw new Error(`Unknown API method: ${method}`);
    }
  }

  // API method implementations
  private async handleGet(key: string, context: ScriptContext): Promise<any> {
    // Restrict access to user's namespace
    const userKey = `scripts:${context.userId}:${key}`;
    const result = await this.kv.get([userKey]);
    return result.value;
  }

  private async handleSet(
    key: string,
    value: any,
    context: ScriptContext,
  ): Promise<void> {
    // Restrict access to user's namespace
    const userKey = `scripts:${context.userId}:${key}`;
    await this.kv.set([userKey], value);
  }

  private async handleFetch(
    url: string,
    options: RequestInit = {},
    context: ScriptContext,
  ): Promise<Response> {
    // Security restrictions
    const allowedDomains =
      (await this.config.get<string[]>("scripts.allowed_domains")) || [];

    const urlObj = new URL(url);
    if (!allowedDomains.includes(urlObj.hostname)) {
      throw new Error(`Domain not allowed: ${urlObj.hostname}`);
    }

    // Limit request options for security
    const safeOptions: RequestInit = {
      method: options.method || "GET",
      ...(options.headers && { headers: options.headers }),
      ...(options.body && { body: options.body }),
    };

    return await fetch(url, safeOptions);
  }

  private async handleUpdateDocument(
    path: string,
    updates: any,
    context: ScriptContext,
  ): Promise<boolean> {
    // Check permissions
    const permission = await this.permissionService.resolvePermission(
      context.userId,
      path,
    );

    if (
      !this.permissionService.hasPermissionLevel(permission.level, "EDITOR")
    ) {
      throw new Error("Insufficient permissions to update document");
    }

    // Update document
    const result = await this.documentService.updateDocument(
      path,
      context.userId,
      updates as any,
    );
    return result !== null;
  }

  private async handleGetCurrentUser(
    context: ScriptContext,
  ): Promise<UserObject | null> {
    const result = await this.kv.get(["users", "by_id", context.userId]);
    return result.value as UserObject | null;
  }

  /**
   * Get all hook scripts for a specific trigger
   */
  async getHookScriptsForTrigger(trigger: string): Promise<HookScriptObject[]> {
    const scripts: HookScriptObject[] = [];
    const iter = this.kv.list({ prefix: ["hooks", "scripts"] });

    for await (const { value } of iter) {
      const script = value as HookScriptObject;
      if (script.enabled && script.triggers.includes(trigger)) {
        scripts.push(script);
      }
    }

    return scripts;
  }

  /**
   * Execute hook scripts for a specific trigger
   */
  async executeHookScripts(
    trigger: string,
    context: ScriptContext,
    eventData: any,
  ): Promise<void> {
    const scripts = await this.getHookScriptsForTrigger(trigger);

    for (const script of scripts) {
      try {
        // Add event data to script context
        const scriptCode = `
          const eventData = ${JSON.stringify(eventData)};
          const trigger = "${trigger}";

          ${script.script}
        `;

        await this.executeScript(scriptCode, context);

        // Update execution count
        await this.kv.set(["hooks", "scripts", script.id], {
          ...script,
          lastExecuted: new Date(),
          executionCount: script.executionCount + 1,
        });

        getScriptLogger().info("Hook script executed", {
          scriptId: script.id,
          trigger,
          userId: context.userId,
        });
      } catch (error) {
        // Update error count
        await this.kv.set(["hooks", "scripts", script.id], {
          ...script,
          errorCount: script.errorCount + 1,
        });

        getScriptLogger().error("Hook script execution failed", {
          scriptId: script.id,
          trigger,
          error: (error as Error).message,
        });
      }
    }
  }
}

export class ScriptsService {
  private kv: Deno.Kv;
  private config: ConfigService;
  private scriptRunner: ScriptRunner;

  constructor(
    kv: Deno.Kv,
    config: ConfigService,
    documentService: DocumentService,
    permissionService: PermissionService,
  ) {
    this.kv = kv;
    this.config = config;
    this.scriptRunner = new ScriptRunner(
      kv,
      config,
      documentService,
      permissionService,
    );
  }

  /**
   * Create a new hook script
   */
  async createHookScript(
    script: Omit<
      HookScriptObject,
      "id" | "createdAt" | "updatedAt" | "executionCount" | "errorCount"
    >,
  ): Promise<HookScriptObject> {
    const id = crypto.randomUUID();
    const now = new Date();

    const hookScript: HookScriptObject = {
      ...script,
      id,
      createdAt: now,
      updatedAt: now,
      executionCount: 0,
      errorCount: 0,
    };

    await this.kv.set(["hooks", "scripts", id], hookScript);

    getScriptLogger().info("Hook script created", {
      scriptId: id,
      name: script.name,
      triggers: script.triggers,
    });

    return hookScript;
  }

  /**
   * Get hook script by ID
   */
  async getHookScript(id: string): Promise<HookScriptObject | null> {
    const result = await this.kv.get(["hooks", "scripts", id]);
    return result.value as HookScriptObject | null;
  }

  /**
   * Update hook script
   */
  async updateHookScript(
    id: string,
    updates: Partial<HookScriptObject>,
  ): Promise<HookScriptObject | null> {
    const existing = await this.getHookScript(id);
    if (!existing) return null;

    const updated: HookScriptObject = {
      ...existing,
      ...updates,
      id, // Ensure ID doesn't change
      updatedAt: new Date(),
    };

    await this.kv.set(["hooks", "scripts", id], updated);
    return updated;
  }

  /**
   * Delete hook script
   */
  async deleteHookScript(id: string): Promise<boolean> {
    const existing = await this.getHookScript(id);
    if (!existing) return false;

    await this.kv.delete(["hooks", "scripts", id]);
    return true;
  }

  /**
   * List all hook scripts
   */
  async listHookScripts(): Promise<HookScriptObject[]> {
    const scripts: HookScriptObject[] = [];
    const iter = this.kv.list({ prefix: ["hooks", "scripts"] });

    for await (const { value } of iter) {
      scripts.push(value as HookScriptObject);
    }

    return scripts.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Execute a script
   */
  async executeScript(
    script: string,
    context: ScriptContext,
  ): Promise<ScriptResult> {
    return await this.scriptRunner.executeScript(script, context);
  }

  /**
   * Execute hook scripts for an event
   */
  async executeHookScripts(
    trigger: string,
    context: ScriptContext,
    eventData: any,
  ): Promise<void> {
    return await this.scriptRunner.executeHookScripts(
      trigger,
      context,
      eventData,
    );
  }
}

// Singleton instance
let scriptsService: ScriptsService | null = null;

/**
 * Get the global scripts service instance
 */
export function getScriptsService(): ScriptsService {
  if (!scriptsService) {
    throw new Error(
      "Scripts service not initialized. Call createScriptsService() first.",
    );
  }
  return scriptsService;
}

/**
 * Create and initialize the global scripts service
 */
export async function createScriptsService(
  kv: Deno.Kv,
  config: ConfigService,
  documentService: DocumentService,
  permissionService: PermissionService,
): Promise<ScriptsService> {
  if (scriptsService) {
    return scriptsService;
  }

  scriptsService = new ScriptsService(
    kv,
    config,
    documentService,
    permissionService,
  );
  getScriptLogger().info("Scripts service initialized");
  return scriptsService;
}
