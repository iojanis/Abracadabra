#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Verification script for newly created users
 * Tests user existence and authentication directly
 */

import { createAuthService } from "../src/auth.ts";
import { createPermissionService } from "../src/services/permissions.ts";
import { createConfigService } from "../src/services/config.ts";
import { createLoggingService, getLogger } from "../src/services/logging.ts";
import { hash, verify } from "../src/utils/password.ts";

// Initialize logging service first
await createLoggingService();
const logger = getLogger(["scripts", "verify-users"]);

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

const TEST_CREDENTIALS = [
  { username: "admin", password: "admin123456" },
  { username: "alice", password: "alice123456" },
  { username: "bob", password: "bob123456789" },
  { username: "charlie", password: "charlie123456" },
  { username: "demo", password: "demo12345678" },
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

async function listAllUsers(kv: Deno.Kv): Promise<void> {
  logger.info("📋 Listing all users in KV store...");

  const userRecords: UserObject[] = [];
  const usernameIndexes: Array<{ username: string; userId: string }> = [];

  for await (const entry of kv.list({ prefix: ["users"] })) {
    const keyParts = entry.key.map(k => String(k));

    if (keyParts.length === 3 && keyParts[1] === "by_id") {
      // User record: users/by_id/{userId}
      userRecords.push(entry.value as UserObject);
    } else if (keyParts.length === 3 && keyParts[1] === "by_username") {
      // Username index: users/by_username/{username}
      usernameIndexes.push({
        username: keyParts[2],
        userId: entry.value as string,
      });
    }
  }

  logger.info(`Found ${userRecords.length} user records and ${usernameIndexes.length} username indexes`);

  userRecords.forEach(user => {
    logger.info(`👤 User: ${user.username} (${user.email})`);
    logger.info(`   ID: ${user.id}`);
    logger.info(`   Active: ${user.isActive}`);
    logger.info(`   Has Password: ${!!user.hashedPassword}`);
    logger.info(`   Created: ${user.createdAt}`);
  });

  usernameIndexes.forEach(index => {
    logger.info(`🔗 Index: ${index.username} -> ${index.userId}`);
  });
}

async function testDirectPasswordVerification(kv: Deno.Kv): Promise<void> {
  logger.info("🔐 Testing direct password verification...");

  for (const cred of TEST_CREDENTIALS) {
    logger.info(`Testing ${cred.username}...`);

    try {
      // Get user by username index
      const usernameKey = ["users", "by_username", cred.username];
      const indexResult = await kv.get(usernameKey);

      if (!indexResult.value) {
        logger.error(`❌ No username index found for: ${cred.username}`);
        continue;
      }

      const userId = indexResult.value as string;
      logger.info(`✅ Found username index: ${cred.username} -> ${userId}`);

      // Get user record
      const userKey = ["users", "by_id", userId];
      const userResult = await kv.get(userKey);

      if (!userResult.value) {
        logger.error(`❌ No user record found for ID: ${userId}`);
        continue;
      }

      const user = userResult.value as UserObject;
      logger.info(`✅ Found user record: ${user.username} (${user.email})`);

      if (!user.hashedPassword) {
        logger.error(`❌ User has no hashed password!`);
        continue;
      }

      logger.info(`🔒 Password hash: ${user.hashedPassword.substring(0, 30)}...`);

      // Test password verification
      const isValid = await verify(user.hashedPassword, cred.password);

      if (isValid) {
        logger.info(`✅ Password verification SUCCESS for ${cred.username}`);
      } else {
        logger.error(`❌ Password verification FAILED for ${cred.username}`);
        logger.error(`   Expected: "${cred.password}"`);
        logger.error(`   Hash: ${user.hashedPassword}`);
      }

    } catch (error) {
      logger.error(`💥 Error testing ${cred.username}:`, error);
    }
  }
}

async function testAuthService(kv: Deno.Kv): Promise<void> {
  logger.info("🔧 Testing AuthService directly...");

  try {
    const configService = await createConfigService(kv);
    const permissionService = await createPermissionService(kv, configService);
    const authService = await createAuthService(kv, configService, permissionService);

    for (const cred of TEST_CREDENTIALS) {
      logger.info(`Testing AuthService.login for ${cred.username}...`);

      try {
        const result = await authService.login({
          identifier: cred.username,
          password: cred.password,
        });

        if (result.success) {
          logger.info(`✅ AuthService login SUCCESS for ${cred.username}`);
          logger.info(`   User ID: ${result.user?.id}`);
          logger.info(`   Session: ${result.session?.id.substring(0, 20)}...`);
        } else {
          logger.error(`❌ AuthService login FAILED for ${cred.username}`);
          logger.error(`   Error: ${result.error?.code} - ${result.error?.message}`);
        }

      } catch (error) {
        logger.error(`💥 AuthService error for ${cred.username}:`, error);
      }
    }

  } catch (error) {
    logger.error("Failed to initialize AuthService:", error);
  }
}

async function testPasswordHashing(): Promise<void> {
  logger.info("🧪 Testing password hashing utility...");

  const testPassword = "admin123456";

  try {
    // Hash password
    const hashed = await hash(testPassword);
    logger.info(`✅ Hash created: ${hashed}`);

    // Verify password
    const verified = await verify(hashed, testPassword);
    logger.info(`${verified ? "✅" : "❌"} Verification result: ${verified}`);

    // Test wrong password
    const wrongVerified = await verify(hashed, "wrongpassword");
    logger.info(`${!wrongVerified ? "✅" : "❌"} Wrong password correctly rejected: ${!wrongVerified}`);

    if (verified && !wrongVerified) {
      logger.info("✅ Password utility is working correctly");
    } else {
      logger.error("❌ Password utility has issues");
    }

  } catch (error) {
    logger.error("💥 Password hashing test failed:", error);
  }
}

async function main(): Promise<void> {
  logger.info("🔍 Starting user verification...");

  let kv: Deno.Kv | null = null;

  try {
    // Connect to KV store
    kv = await createKvConnection();
    logger.info("✅ Connected to KV store");

    // List all users
    await listAllUsers(kv);

    console.log("\n" + "=".repeat(60));

    // Test password hashing utility
    await testPasswordHashing();

    console.log("\n" + "=".repeat(60));

    // Test direct password verification
    await testDirectPasswordVerification(kv);

    console.log("\n" + "=".repeat(60));

    // Test AuthService
    await testAuthService(kv);

    console.log("\n" + "=".repeat(60));
    logger.info("🎯 Verification Summary:");
    logger.info("- Check the logs above for any ❌ FAILED messages");
    logger.info("- If password utility works but AuthService fails, the bug is in AuthService");
    logger.info("- If direct verification works but API fails, the bug is in the route");
    logger.info("- If everything works here but client fails, the bug is in client/server communication");

  } catch (error) {
    logger.error("Failed to verify users:", error);
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
