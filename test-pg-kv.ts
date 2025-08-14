#!/usr/bin/env deno run --allow-all

// Test script for PostgreSQL KV implementation
// This tests the JSONB fixes and ensures the PG-KV wrapper works correctly

import { Pool } from "npm:pg";
import { openKvPostgres } from "./src/utils/pg-kv.ts";

// Test configuration
const TEST_DATABASE_URL = Deno.env.get("TEST_DATABASE_URL") ||
  "postgresql://postgres:password@localhost:5432/postgres";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

async function runTests(): Promise<void> {
  const results: TestResult[] = [];

  console.log("🧪 Starting PostgreSQL KV Tests...\n");
  console.log(`Using database: ${TEST_DATABASE_URL}\n`);

  try {
    // Test database connection
    console.log("📡 Testing database connection...");
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query("SELECT 1");
    await pool.end();
    console.log("✅ Database connection successful\n");

    // Test 1: Basic KV operations
    await testBasicOperations(results);

    // Test 2: Complex data types
    await testComplexDataTypes(results);

    // Test 3: Key variations
    await testKeyVariations(results);

    // Test 4: Legacy data migration
    await testLegacyDataMigration(results);

    // Test 5: Atomic operations
    await testAtomicOperations(results);

  } catch (error) {
    console.error("❌ Failed to connect to database:", error.message);
    console.log("\n💡 Make sure PostgreSQL is running and accessible:");
    console.log("   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=password postgres");
    console.log("   or set TEST_DATABASE_URL environment variable");
    return;
  }

  // Print results
  console.log("\n📊 Test Results:");
  console.log("================");

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    if (result.passed) {
      console.log(`✅ ${result.name}`);
      passed++;
    } else {
      console.log(`❌ ${result.name}: ${result.error}`);
      failed++;
    }
  }

  console.log(`\n📈 Summary: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    Deno.exit(1);
  } else {
    console.log("🎉 All tests passed!");
  }
}

async function testBasicOperations(results: TestResult[]): Promise<void> {
  console.log("🔧 Testing basic KV operations...");

  try {
    const kv = await openKvPostgres(TEST_DATABASE_URL);

    // Test set and get
    const key = ["test", "basic"];
    const value = "hello world";

    await kv.set(key, value);
    const result = await kv.get(key);

    if (result?.value === value && JSON.stringify(result.key) === JSON.stringify(key)) {
      results.push({ name: "Basic set/get", passed: true });
    } else {
      results.push({
        name: "Basic set/get",
        passed: false,
        error: `Expected value: ${value}, got: ${result?.value}`
      });
    }

    // Test delete
    await kv.delete(key);
    const deletedResult = await kv.get(key);

    if (deletedResult === null) {
      results.push({ name: "Delete operation", passed: true });
    } else {
      results.push({
        name: "Delete operation",
        passed: false,
        error: "Key still exists after deletion"
      });
    }

    await kv.close();

  } catch (error) {
    results.push({
      name: "Basic operations",
      passed: false,
      error: error.message
    });
  }
}

async function testComplexDataTypes(results: TestResult[]): Promise<void> {
  console.log("🧮 Testing complex data types...");

  try {
    const kv = await openKvPostgres(TEST_DATABASE_URL);

    const testCases = [
      {
        name: "Object",
        key: ["test", "object"],
        value: { name: "John", age: 30, active: true }
      },
      {
        name: "Array",
        key: ["test", "array"],
        value: [1, 2, 3, "four", { five: 5 }]
      },
      {
        name: "Number",
        key: ["test", "number"],
        value: 42.5
      },
      {
        name: "Boolean",
        key: ["test", "boolean"],
        value: true
      },
      {
        name: "Null",
        key: ["test", "null"],
        value: null
      },
      {
        name: "Nested Object",
        key: ["test", "nested"],
        value: {
          user: {
            profile: {
              settings: {
                theme: "dark",
                notifications: true
              }
            }
          }
        }
      }
    ];

    for (const testCase of testCases) {
      await kv.set(testCase.key, testCase.value);
      const result = await kv.get(testCase.key);

      if (JSON.stringify(result?.value) === JSON.stringify(testCase.value)) {
        results.push({ name: `Complex type: ${testCase.name}`, passed: true });
      } else {
        results.push({
          name: `Complex type: ${testCase.name}`,
          passed: false,
          error: `Value mismatch. Expected: ${JSON.stringify(testCase.value)}, Got: ${JSON.stringify(result?.value)}`
        });
      }
    }

    await kv.close();

  } catch (error) {
    results.push({
      name: "Complex data types",
      passed: false,
      error: error.message
    });
  }
}

async function testKeyVariations(results: TestResult[]): Promise<void> {
  console.log("🗝️ Testing key variations...");

  try {
    const kv = await openKvPostgres(TEST_DATABASE_URL);

    const keyTests = [
      {
        name: "String keys",
        key: ["users", "123", "profile"],
        value: "profile data"
      },
      {
        name: "Number keys",
        key: ["items", 456, "details"],
        value: "item details"
      },
      {
        name: "Mixed keys",
        key: ["mixed", 123, "data", true],
        value: "mixed key data"
      },
      {
        name: "Single key",
        key: ["single"],
        value: "single key value"
      }
    ];

    for (const test of keyTests) {
      await kv.set(test.key, test.value);
      const result = await kv.get(test.key);

      if (result?.value === test.value) {
        results.push({ name: `Key variation: ${test.name}`, passed: true });
      } else {
        results.push({
          name: `Key variation: ${test.name}`,
          passed: false,
          error: `Expected: ${test.value}, Got: ${result?.value}`
        });
      }
    }

    await kv.close();

  } catch (error) {
    results.push({
      name: "Key variations",
      passed: false,
      error: error.message
    });
  }
}

async function testLegacyDataMigration(results: TestResult[]): Promise<void> {
  console.log("🔄 Testing legacy data migration...");

  try {
    // Create direct database connection to insert legacy data
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });

    // Insert legacy comma-separated key
    await pool.query(`
      INSERT INTO deno_kv (key_path, value)
      VALUES ($1, $2)
      ON CONFLICT (key_path) DO UPDATE SET value = EXCLUDED.value
    `, ["legacy,comma,key", '"legacy value"']);

    // Now test with KV wrapper (which should trigger migration)
    const kv = await openKvPostgres(TEST_DATABASE_URL);

    // The migration should have converted the legacy data
    const result = await kv.get(["legacy", "comma", "key"]);

    if (result?.value === "legacy value") {
      results.push({ name: "Legacy data migration", passed: true });
    } else {
      results.push({
        name: "Legacy data migration",
        passed: false,
        error: `Expected: "legacy value", Got: ${result?.value}`
      });
    }

    await kv.close();
    await pool.end();

  } catch (error) {
    results.push({
      name: "Legacy data migration",
      passed: false,
      error: error.message
    });
  }
}

async function testAtomicOperations(results: TestResult[]): Promise<void> {
  console.log("⚛️ Testing atomic operations...");

  try {
    const kv = await openKvPostgres(TEST_DATABASE_URL);

    const key = ["test", "atomic"];
    const initialValue = "initial";
    const newValue = "updated";

    // Set initial value
    await kv.set(key, initialValue);
    const initialResult = await kv.get(key);

    // Perform atomic operation
    const atomic = kv.atomic();
    atomic.set(key, newValue);
    const commitResult = await atomic.commit();

    if (commitResult?.ok) {
      const finalResult = await kv.get(key);

      if (finalResult?.value === newValue) {
        results.push({ name: "Atomic set operation", passed: true });
      } else {
        results.push({
          name: "Atomic set operation",
          passed: false,
          error: `Value not updated. Expected: ${newValue}, Got: ${finalResult?.value}`
        });
      }
    } else {
      results.push({
        name: "Atomic set operation",
        passed: false,
        error: "Atomic commit failed"
      });
    }

    await kv.close();

  } catch (error) {
    results.push({
      name: "Atomic operations",
      passed: false,
      error: error.message
    });
  }
}

// Run tests if this file is executed directly
if (import.meta.main) {
  await runTests();
}
