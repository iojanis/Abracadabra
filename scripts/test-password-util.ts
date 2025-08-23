#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Simple test to isolate password utility bug
 */

import { hash, verify } from "../src/utils/password.ts";

async function testPasswordUtility() {
  console.log("🧪 Testing password utility...");

  const testPassword = "admin123";
  console.log(`📝 Test password: "${testPassword}"`);

  try {
    // Hash the password
    console.log("🔨 Hashing password...");
    const hashedPassword = await hash(testPassword);
    console.log(`✅ Hash created: ${hashedPassword}`);
    console.log(`📏 Hash length: ${hashedPassword.length}`);

    // Parse the hash components
    const parts = hashedPassword.split("$");
    console.log(`🔍 Hash parts: ${parts.length} (should be 3)`);
    if (parts.length === 3) {
      console.log(`   Iterations: ${parts[0]}`);
      console.log(`   Salt (base64): ${parts[1]} (length: ${parts[1].length})`);
      console.log(`   Hash (base64): ${parts[2]} (length: ${parts[2].length})`);
    }

    // Immediately verify the same password
    console.log("🔍 Verifying password...");
    const isValid = await verify(hashedPassword, testPassword);

    if (isValid) {
      console.log("✅ SUCCESS: Password verification worked!");
    } else {
      console.log("❌ FAILED: Password verification failed!");
      console.log("This confirms there's a bug in the verify function.");
    }

    // Test with wrong password
    console.log("🧪 Testing with wrong password...");
    const wrongResult = await verify(hashedPassword, "wrongpassword");
    if (!wrongResult) {
      console.log("✅ Correctly rejected wrong password");
    } else {
      console.log("❌ Incorrectly accepted wrong password!");
    }

  } catch (error) {
    console.error("💥 Error during test:", error);
  }
}

// Test multiple passwords
async function runTests() {
  const passwords = ["admin123", "test", "hello123", "a".repeat(20)];

  for (const password of passwords) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Testing password: "${password}"`);

    try {
      const hashed = await hash(password);
      const verified = await verify(hashed, password);

      console.log(`Hash: ${hashed}`);
      console.log(`Verify: ${verified ? "✅ PASS" : "❌ FAIL"}`);

      if (!verified) {
        console.log("🐛 BUG DETECTED: Hash doesn't verify against original password");
      }
    } catch (error) {
      console.error(`Error with password "${password}":`, error);
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("Test completed");
}

if (import.meta.main) {
  await runTests();
}
