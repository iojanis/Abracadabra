import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";
import memoryDriver from "unstorage/drivers/memory";
import { getEnv, isTest, getCwd } from "../utils/runtime.ts";
import path from "node:path";

// Determine storage path
const storagePath = getEnv("STORAGE_PATH") || path.join(getCwd(), "storage");

// Select driver
// In test mode, use memory. Otherwise use filesystem.
const driver = isTest
    ? memoryDriver()
    : fsDriver({ base: storagePath });

export const storage = createStorage({
    driver,
});

/**
 * Initialize storage (ensure directory exists if using FS)
 */
export async function initStorage() {
    // unstorage fs driver lazy creates, but we might want to log or check permissions here
    // For now, this is a placeholder if we need explicit initialization.
    console.log(`[Storage] Initialized with driver: ${isTest ? "memory" : "fs"}`);
    if (!isTest) {
        console.log(`[Storage] Path: ${storagePath}`);
    }
}
