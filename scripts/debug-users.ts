#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Debug script to check users in KV store
 * Helps diagnose authentication issues by inspecting stored user data
 */

import { createLoggingService, getLogger } from "../src/services/logging.ts";

// Initialize logging service first
await createLoggingService();
const logger = getLogger(["scripts", "debug-users"]);

interface UserObject {
  id: string;
  username: string;
  email: string;
  displayName: string;
  hashedPassword?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  settings: Record<string, any>;
}

type UsernameIndexKey = ["users", "by_username", string];
type EmailIndexKey = ["users", "by_email", string];
type UserKey = ["users", "by_id", string];

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

async function listAllUsers(kv: Deno.Kv): Promise<void> {
  logger.info("🔍 Scanning KV store for users...");

  // List all entries with "users" prefix
  const userEntries: Array<{ key: string; value: any }> = [];

  for await (const entry of kv.list({ prefix: ["users"] })) {
    userEntries.push({
      key: entry.key.join("/"),
      value: entry.value,
    });
  }

  logger.info(`Found ${userEntries.length} user-related entries in KV store`);

  // Group entries by type
  const userRecords: UserObject[] = [];
  const usernameIndexes: Array<{ username: string; userId: string }> = [];
  const emailIndexes: Array<{ email: string; userId: string }> = [];

  for (const entry of userEntries) {
    const keyParts = entry.key.split("/");

    if (
      keyParts.length === 3 &&
      keyParts[0] === "users" &&
      keyParts[1] === "by_id"
    ) {
      // This is a user record: users/by_id/{userId}
      userRecords.push(entry.value as UserObject);
    } else if (keyParts.length === 3 && keyParts[1] === "by_username") {
      // This is a username index: users/by_username/{username}
      usernameIndexes.push({
        username: keyParts[2],
        userId: entry.value as string,
      });
    } else if (keyParts.length === 3 && keyParts[1] === "by_email") {
      // This is an email index: users/by_email/{email}
      emailIndexes.push({
        email: keyParts[2],
        userId: entry.value as string,
      });
    }
  }

  logger.info(`📊 User data summary:`);
  logger.info(`  - User records: ${userRecords.length}`);
  logger.info(`  - Username indexes: ${usernameIndexes.length}`);
  logger.info(`  - Email indexes: ${emailIndexes.length}`);

  // Display user records
  if (userRecords.length > 0) {
    logger.info(`\n👥 User Records:`);
    for (const user of userRecords) {
      logger.info(`  User ID: ${user.id}`);
      logger.info(`    Username: ${user.username}`);
      logger.info(`    Email: ${user.email}`);
      logger.info(`    Display Name: ${user.displayName}`);
      logger.info(`    Is Active: ${user.isActive}`);
      logger.info(`    Has Password: ${!!user.hashedPassword}`);
      logger.info(`    Created: ${user.createdAt}`);
      logger.info(`    Updated: ${user.updatedAt}`);
      logger.info(`    Settings: ${JSON.stringify(user.settings, null, 2)}`);
      logger.info(`    ---`);
    }
  }

  // Display username indexes
  if (usernameIndexes.length > 0) {
    logger.info(`\n🔗 Username Indexes:`);
    for (const index of usernameIndexes) {
      logger.info(`  ${index.username} -> ${index.userId}`);
    }
  }

  // Display email indexes
  if (emailIndexes.length > 0) {
    logger.info(`\n📧 Email Indexes:`);
    for (const index of emailIndexes) {
      logger.info(`  ${index.email} -> ${index.userId}`);
    }
  }

  // Check for orphaned indexes
  const userIds = new Set(userRecords.map((u) => u.id));
  const usernameIndexUserIds = new Set(usernameIndexes.map((i) => i.userId));
  const emailIndexUserIds = new Set(emailIndexes.map((i) => i.userId));

  const orphanedUsernameIndexes = usernameIndexes.filter(
    (i) => !userIds.has(i.userId),
  );
  const orphanedEmailIndexes = emailIndexes.filter(
    (i) => !userIds.has(i.userId),
  );

  if (orphanedUsernameIndexes.length > 0 || orphanedEmailIndexes.length > 0) {
    logger.warn(`\n⚠️  Orphaned Indexes Found:`);
    if (orphanedUsernameIndexes.length > 0) {
      logger.warn(
        `  Orphaned username indexes: ${orphanedUsernameIndexes.length}`,
      );
      orphanedUsernameIndexes.forEach((i) =>
        logger.warn(`    ${i.username} -> ${i.userId} (user not found)`),
      );
    }
    if (orphanedEmailIndexes.length > 0) {
      logger.warn(`  Orphaned email indexes: ${orphanedEmailIndexes.length}`);
      orphanedEmailIndexes.forEach((i) =>
        logger.warn(`    ${i.email} -> ${i.userId} (user not found)`),
      );
    }
  }
}

async function testSpecificUser(
  kv: Deno.Kv,
  identifier: string,
): Promise<void> {
  logger.info(`\n🧪 Testing user lookup: "${identifier}"`);

  // Try username lookup
  const usernameKey: UsernameIndexKey = ["users", "by_username", identifier];
  const usernameResult = await kv.get(usernameKey);

  if (usernameResult.value) {
    logger.info(
      `✅ Found username index: ${identifier} -> ${usernameResult.value}`,
    );

    // Get the actual user record
    const userKey: UserKey = ["users", "by_id", usernameResult.value as string];
    const userResult = await kv.get(userKey);

    if (userResult.value) {
      const user = userResult.value as UserObject;
      logger.info(`✅ Found user record:`);
      logger.info(`    Username: ${user.username}`);
      logger.info(`    Email: ${user.email}`);
      logger.info(`    Active: ${user.isActive}`);
      logger.info(`    Has Password: ${!!user.hashedPassword}`);

      if (user.hashedPassword) {
        logger.info(
          `    Password Hash: ${user.hashedPassword.substring(0, 20)}...`,
        );
      }
    } else {
      logger.error(
        `❌ Username index points to non-existent user: ${usernameResult.value}`,
      );
    }
  } else {
    logger.warn(`❌ No username index found for: ${identifier}`);
  }

  // If identifier looks like email, try email lookup
  if (identifier.includes("@")) {
    const emailKey: EmailIndexKey = ["users", "by_email", identifier];
    const emailResult = await kv.get(emailKey);

    if (emailResult.value) {
      logger.info(
        `✅ Found email index: ${identifier} -> ${emailResult.value}`,
      );
    } else {
      logger.warn(`❌ No email index found for: ${identifier}`);
    }
  }
}

async function main(): Promise<void> {
  logger.info("🔍 Starting user debug session...");

  let kv: Deno.Kv | null = null;

  try {
    // Connect to KV store
    kv = await createKvConnection();
    logger.info("Connected to KV store");

    // List all users
    await listAllUsers(kv);

    // Test specific users that should exist
    const testUsers = ["admin", "alice", "charlie", "admin@abracadabra.dev"];

    for (const testUser of testUsers) {
      await testSpecificUser(kv, testUser);
    }

    logger.info("\n🎯 Debug Summary:");
    logger.info("If you see users above, the data exists correctly.");
    logger.info(
      "If you don't see any users, run: deno run --allow-all scripts/create-test-users.ts",
    );
    logger.info(
      "If you see orphaned indexes, there may be data consistency issues.",
    );
  } catch (error) {
    logger.error("Failed to debug users:", error);
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
