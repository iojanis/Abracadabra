// Runtime Detection & Abstraction Utility
// Provides a unified interface for accessing runtime-specific features (Deno, Bun, Node)

export type RuntimeType = "deno" | "bun" | "node" | "unknown";

/**
 * Detect the current runtime environment
 */
export function getRuntime(): RuntimeType {
    // @ts-ignore: Deno global detection
    if (typeof Deno !== "undefined") {
        return "deno";
    }
    // @ts-ignore: Bun global detection
    if (typeof Bun !== "undefined") {
        return "bun";
    }
    // @ts-ignore: Node process detection
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
        return "node";
    }
    return "unknown";
}

export const isDeno = getRuntime() === "deno";
export const isBun = getRuntime() === "bun";
export const isNode = getRuntime() === "node";

export const isTest =
    getEnv("NODE_ENV") === "test" ||
    getEnv("DENO_ENV") === "test" ||
    getEnv("TEST_RUN") === "true";

/**
 * Get an environment variable in a runtime-agnostic way
 */
export function getEnv(key: string): string | undefined {
    if (isDeno) {
        // @ts-ignore: Deno global usage
        return Deno.env.get(key);
    }
    if (isBun) {
        // @ts-ignore: Bun global usage
        return Bun.env[key];
    }
    if (isNode) {
        // @ts-ignore: Node global usage
        return process.env[key];
    }
    return undefined;
}

/**
 * Get the current working directory
 */
export function getCwd(): string {
    if (isDeno) {
        // @ts-ignore: Deno global usage
        return Deno.cwd();
    }
    if (isBun) {
        // @ts-ignore: Node/Bun compatibility
        return process.cwd();
    }
    if (isNode) {
        // @ts-ignore: Node global usage
        return process.cwd();
    }
    return "";
}

/**
 * Exit the process with a status code
 */
export function exit(code: number = 0): void {
    if (isDeno) {
        // @ts-ignore: Deno global usage
        Deno.exit(code);
    } else {
        // @ts-ignore: Node/Bun global usage
        process.exit(code);
    }
}
