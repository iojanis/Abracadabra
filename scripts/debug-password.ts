#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Debug script to test password verification
 * Helps diagnose password hashing/verification issues
 */

import { hash, verify } from "../src/utils/password.ts";
import { createLoggingService, getLogger } from "../src/services/logging.ts";

// Initialize logging service first
await createLoggingService();
const logger = getLogger(["scripts", "debug-password"]);

type UserKey = ["users", "by_id", string];
type UsernameIndexKey = ["users", "by_username", string];

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

async function getUserByUsername(
  kv: Deno.Kv,
  username: string,
): Promise<UserObject | null> {
  const indexKey: UsernameIndexKey = ["users", "by_username", username];
  const indexResult = await kv.get(indexKey);

  if (!indexResult.value) {
    logger.info(`❌ No username index found for: ${username}`);
    return null;
  }

  const userId = indexResult.value as string;
  logger.info(`✅ Found username index: ${username} -> ${userId}`);

  const userKey: UserKey = ["users", "by_id", userId];
  const userResult = await kv.get(userKey);

  if (!userResult.value) {
    logger.error(`❌ Username index points to non-existent user: ${userId}`);
    return null;
  }

  return userResult.value as UserObject;
}

async function testPasswordVerification(
  username: string,
  password: string,
): Promise<void> {
  logger.info(`🔍 Testing password verification for: ${username}`);
  logger.info(`📝 Password to test: "${password}"`);

  let kv: Deno.Kv | null = null;

  try {
    // Connect to KV store
    kv = await createKvConnection();
    logger.info("✅ Connected to KV store");

    // Get user
    const user = await getUserByUsername(kv, username);
    if (!user) {
      logger.error(`❌ User not found: ${username}`);
      return;
    }

    logger.info(`✅ Found user: ${user.username} (${user.email})`);
    logger.info(`📧 Email: ${user.email}`);
    logger.info(`👤 Display Name: ${user.displayName}`);
    logger.info(`🟢 Is Active: ${user.isActive}`);
    logger.info(`📅 Created: ${user.createdAt}`);

    if (!user.hashedPassword) {
      logger.error(`❌ User has no hashed password!`);
      return;
    }

    logger.info(
      `🔒 Has hashed password: ${user.hashedPassword.length} characters`,
    );
    logger.info(
      `🔒 Password hash preview: ${user.hashedPassword.substring(0, 30)}...`,
    );

    // Test password verification
    logger.info(`🧪 Testing password verification...`);

    const startTime = Date.now();
    let isValid: boolean;

    try {
      isValid = await verify(password, user.hashedPassword);
      const verificationTime = Date.now() - startTime;

      if (isValid) {
        logger.info(
          `✅ Password verification SUCCESSFUL! (${verificationTime}ms)`,
        );
      } else {
        logger.error(
          `❌ Password verification FAILED! (${verificationTime}ms)`,
        );
        logger.error(`   Expected password: "${password}"`);
        logger.error(`   Stored hash: ${user.hashedPassword}`);
      }
    } catch (verifyError) {
      const verificationTime = Date.now() - startTime;
      logger.error(
        `💥 Password verification threw an error! (${verificationTime}ms)`,
      );
      logger.error(`   Error: ${(verifyError as Error).message}`);
      logger.error(`   Stack: ${(verifyError as Error).stack}`);
    }

    // Additional test: try hashing the password and compare format
    logger.info(`🧪 Testing password hashing for comparison...`);
    try {
      const hashStartTime = Date.now();
      const newHash = await hash(password);
      const hashTime = Date.now() - hashStartTime;

      logger.info(`✅ New hash created successfully! (${hashTime}ms)`);
      logger.info(`🆕 New hash: ${newHash}`);
      logger.info(`📏 New hash length: ${newHash.length}`);
      logger.info(`🔍 Hash format comparison:`);
      logger.info(`   Stored:  ${user.hashedPassword.substring(0, 50)}...`);
      logger.info(`   Fresh:   ${newHash.substring(0, 50)}...`);

      // Test if the new hash verifies correctly
      const newVerifyStartTime = Date.now();
      const newHashVerifies = await verify(password, newHash);
      const newVerifyTime = Date.now() - newVerifyStartTime;

      if (newHashVerifies) {
        logger.info(`✅ Fresh hash verifies correctly! (${newVerifyTime}ms)`);
      } else {
        logger.error(
          `❌ Fresh hash verification failed! This indicates a bcrypt issue.`,
        );
      }
    } catch (hashError) {
      logger.error(`💥 Password hashing failed!`);
      logger.error(`   Error: ${(hashError as Error).message}`);
    }
  } catch (error) {
    logger.error("Failed to test password verification:", error);
  } finally {
    if (kv) {
      kv.close();
    }
  }
}

async function main(): Promise<void> {
  logger.info("🔒 Starting password verification debug session...");

  const testCases = [
    { username: "admin", password: "admin123" },
    { username: "alice", password: "alice123" },
    { username: "charlie", password: "charlie123" },
    // Test with wrong password
    { username: "admin", password: "wrongpassword" },
  ];

  for (const testCase of testCases) {
    logger.info(`\n${"=".repeat(60)}`);
    await testPasswordVerification(testCase.username, testCase.password);
  }

  logger.info(`\n${"=".repeat(60)}`);
  logger.info("🎯 Debug Summary:");
  logger.info(
    "- If password verification works, the issue is elsewhere in auth flow",
  );
  logger.info(
    "- If password verification fails, check bcrypt library compatibility",
  );
  logger.info("- If hashing fails, there may be a bcrypt installation issue");
}

// Run the script
if (import.meta.main) {
  await main();
}
