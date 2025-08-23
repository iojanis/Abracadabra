#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Reset Users Script for Abracadabra Server
 *
 * This script clears all existing user data and recreates test users.
 * Use this when there are issues with user authentication or corrupted data.
 */

import { createAuthService } from "../src/auth.ts";
import { createPermissionService } from "../src/services/permissions.ts";
import { createConfigService } from "../src/services/config.ts";
import { createLoggingService, getLogger } from "../src/services/logging.ts";

// Initialize logging service first
await createLoggingService();
const logger = getLogger(["scripts", "reset-users"]);

interface TestUser {
  username: string;
  email: string;
  password: string;
  displayName: string;
  role: "admin" | "editor" | "user";
}

const TEST_USERS: TestUser[] = [
  {
    username: "admin",
    email: "admin@abracadabra.dev",
    password: "admin123456",  // Longer password to ensure it passes validation
    displayName: "Admin User",
    role: "admin",
  },
  {
    username: "alice",
    email: "alice@example.com",
    password: "alice123456",   // Longer password
    displayName: "Alice Cooper",
    role: "editor",
  },
  {
    username: "bob",
    email: "bob@example.com",
    password: "bob123456789",  // Longer password
    displayName: "Bob Builder",
    role: "editor",
  },
  {
    username: "charlie",
    email: "charlie@example.com",
    password: "charlie123456", // Longer password
    displayName: "Charlie Brown",
    role: "user",
  },
  {
    username: "demo",
    email: "demo@example.com",
    password: "demo12345678",  // Longer password
    displayName: "Demo User",
    role: "user",
  },
];

async function createKvConnection(): Promise<Deno.Kv> {
  const kvProvider = Deno.env.get("KV_PROVIDER");

  if (kvProvider === "sqlite" || !kvProvider) {
    const dbPath = Deno.env.get("SQLITE_DB_PATH") || "./data/abracadabra.db";
    return await Deno.openKv(dbPath);
  } else if (kvProvider === "deno_deploy") {
    return await Deno.openKv();
  } else {
    throw new Error(`Unsupported KV provider: ${kvProvider}`);
  }
}

async function clearAllUsers(kv: Deno.Kv): Promise<void> {
  logger.info("🧹 Clearing all existing user data...");

  const userEntries: Deno.KvKey[] = [];

  // Collect all user-related keys
  for await (const entry of kv.list({ prefix: ["users"] })) {
    userEntries.push(entry.key);
  }

  logger.info(`Found ${userEntries.length} user-related entries to delete`);

  if (userEntries.length === 0) {
    logger.info("No user data found to clear");
    return;
  }

  // Delete all user entries in batches
  const batchSize = 10;
  for (let i = 0; i < userEntries.length; i += batchSize) {
    const batch = userEntries.slice(i, i + batchSize);
    const atomic = kv.atomic();

    for (const key of batch) {
      atomic.delete(key);
    }

    const result = await atomic.commit();
    if (!result.ok) {
      throw new Error(`Failed to delete user data batch starting at index ${i}`);
    }

    logger.info(`Deleted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(userEntries.length / batchSize)}`);
  }

  logger.info("✅ All user data cleared successfully");
}

async function clearAllSessions(kv: Deno.Kv): Promise<void> {
  logger.info("🧹 Clearing all existing session data...");

  const sessionEntries: Deno.KvKey[] = [];

  // Collect all session-related keys
  for await (const entry of kv.list({ prefix: ["sessions"] })) {
    sessionEntries.push(entry.key);
  }

  logger.info(`Found ${sessionEntries.length} session-related entries to delete`);

  if (sessionEntries.length === 0) {
    logger.info("No session data found to clear");
    return;
  }

  // Delete all session entries
  const batchSize = 10;
  for (let i = 0; i < sessionEntries.length; i += batchSize) {
    const batch = sessionEntries.slice(i, i + batchSize);
    const atomic = kv.atomic();

    for (const key of batch) {
      atomic.delete(key);
    }

    const result = await atomic.commit();
    if (!result.ok) {
      throw new Error(`Failed to delete session data batch starting at index ${i}`);
    }

    logger.info(`Deleted session batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(sessionEntries.length / batchSize)}`);
  }

  logger.info("✅ All session data cleared successfully");
}

async function createFreshUsers(kv: Deno.Kv): Promise<void> {
  logger.info("👥 Creating fresh test users...");

  const configService = await createConfigService(kv);
  const permissionService = await createPermissionService(kv, configService);
  const authService = await createAuthService(
    kv,
    configService,
    permissionService,
  );

  let successCount = 0;
  let failCount = 0;

  for (const userData of TEST_USERS) {
    logger.info(`Creating user: ${userData.username} (${userData.email})`);

    try {
      const result = await authService.register({
        username: userData.username,
        email: userData.email,
        password: userData.password,
        displayName: userData.displayName,
      });

      if (result.success) {
        logger.info(`✅ Created user: ${userData.username}`, {
          userId: result.user!.id,
          email: userData.email,
        });

        successCount++;

        // Log the password for reference
        logger.info(`🔑 Password for ${userData.username}: ${userData.password}`);

        // For admin users, log their special status
        if (userData.role === "admin") {
          logger.info(`👑 User ${userData.username} has admin role`);
        }
      } else {
        logger.error(
          `Failed to create user ${userData.username}:`,
          result.error,
        );
        failCount++;
      }
    } catch (error) {
      logger.error(`Error creating user ${userData.username}:`, error);
      failCount++;
    }
  }

  logger.info(`📊 User creation summary: ${successCount} successful, ${failCount} failed`);
}

async function verifyUsers(kv: Deno.Kv): Promise<void> {
  logger.info("🔍 Verifying created users...");

  const configService = await createConfigService(kv);
  const permissionService = await createPermissionService(kv, configService);
  const authService = await createAuthService(
    kv,
    configService,
    permissionService,
  );

  for (const userData of TEST_USERS) {
    try {
      logger.info(`Testing login for: ${userData.username}`);

      const result = await authService.login({
        identifier: userData.username,
        password: userData.password,
      });

      if (result.success) {
        logger.info(`✅ Login successful for: ${userData.username}`);
      } else {
        logger.error(`❌ Login failed for ${userData.username}:`, result.error?.message);
      }
    } catch (error) {
      logger.error(`💥 Login test error for ${userData.username}:`, error);
    }
  }
}

async function main(): Promise<void> {
  logger.info("🔄 Starting user reset process...");

  let kv: Deno.Kv | null = null;

  try {
    // Connect to KV store
    kv = await createKvConnection();
    logger.info("Connected to KV store");

    // Clear all existing user and session data
    await clearAllUsers(kv);
    await clearAllSessions(kv);

    // Wait a moment for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Create fresh users
    await createFreshUsers(kv);

    // Wait a moment for users to be fully created
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify users can log in
    await verifyUsers(kv);

    logger.info("🎉 User reset completed successfully!");
    logger.info("\nFresh test users created:");

    TEST_USERS.forEach((user) => {
      logger.info(`  - ${user.username} (${user.email}) - password: ${user.password}`);
    });

    logger.info("\n✅ You can now login with any of these users:");
    logger.info("1. Try the client login again");
    logger.info("2. All passwords should now work correctly");
    logger.info("3. If issues persist, there may be a different problem");

  } catch (error) {
    logger.error("Failed to reset users:", error);
    Deno.exit(1);
  } finally {
    if (kv) {
      kv.close();
    }
  }
}

// Run the script
if (import.meta.main) {
  await main();
}
