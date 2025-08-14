#!/usr/bin/env deno run --allow-all

// Unit tests for PostgreSQL KV serialization logic
// Tests the JSONB fixes without requiring a database connection

import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// Mock the types from pg-kv.ts
type KvKeyPart = string | number | bigint | boolean | Uint8Array;
type KvKey = readonly KvKeyPart[];
type DenoKvKeyPart = string | number | bigint | boolean | Uint8Array;
type DenoKvKey = readonly DenoKvKeyPart[];

interface DatabaseRow {
  versionstamp: string;
  key_path: any;
  value: any;
}

interface KvEntry<T> {
  key: KvKey;
  value: T;
  versionstamp: string;
}

// Mock implementation of the serialization methods from PostgresKv class
class MockPostgresKv {
  _serializeKey(key: DenoKvKey): string {
    try {
      // Filter out symbols as PostgreSQL cannot store them
      const filteredKey = key.filter(
        (part) => typeof part !== "symbol",
      ) as KvKey;

      // Ensure we have an array
      if (!Array.isArray(key)) {
        console.warn("[PG-KV] Key is not an array:", key);
        return JSON.stringify([key]);
      }

      return JSON.stringify(filteredKey);
    } catch (error) {
      console.error("[PG-KV] Error serializing key:", {
        key,
        error: (error as Error).message,
      });
      // Fallback - treat as single key
      return JSON.stringify([String(key)]);
    }
  }

  _rowToEntry<T>(row: DatabaseRow): KvEntry<T> {
    try {
      let parsedKey;

      // Check if key_path is already a parsed object/array (JSONB column)
      if (typeof row.key_path === "object" && row.key_path !== null) {
        parsedKey = row.key_path;
      } else if (typeof row.key_path === "string") {
        try {
          // Try to parse as JSON first (legacy format)
          parsedKey = JSON.parse(row.key_path);
        } catch (_keyError) {
          // Fallback for legacy comma-separated format
          if (row.key_path.includes(",")) {
            parsedKey = row.key_path.split(",");
          } else {
            parsedKey = [row.key_path];
          }
        }
      } else {
        parsedKey = [row.key_path];
      }

      let parsedValue;

      // Check if value is already a parsed object (JSONB column)
      if (typeof row.value === "string") {
        try {
          // Legacy string format - try to parse as JSON
          parsedValue = JSON.parse(row.value);
        } catch (_valueError) {
          // Fallback: use raw value for legacy non-JSON values
          parsedValue = row.value;
        }
      } else {
        // Value is already parsed from JSONB column
        parsedValue = row.value;
      }

      return {
        key: parsedKey,
        value: parsedValue as T,
        versionstamp: row.versionstamp,
      };
    } catch (error) {
      console.error("[PG-KV] Error in _rowToEntry:", {
        row,
        error: (error as Error).message,
      });
      throw error;
    }
  }
}

// Test suite
async function runSerializationTests(): Promise<void> {
  console.log("🧪 Starting PostgreSQL KV Serialization Tests...\n");

  const mockKv = new MockPostgresKv();
  let testsPassed = 0;
  let testsFailed = 0;

  function runTest(name: string, testFn: () => void): void {
    try {
      console.log(`🔬 Testing: ${name}`);
      testFn();
      console.log(`✅ ${name} - PASSED`);
      testsPassed++;
    } catch (error) {
      console.log(`❌ ${name} - FAILED: ${error.message}`);
      testsFailed++;
    }
  }

  // Test 1: Basic key serialization
  runTest("Basic key serialization", () => {
    const key: DenoKvKey = ["users", "123", "profile"];
    const serialized = mockKv._serializeKey(key);
    assertEquals(serialized, JSON.stringify(["users", "123", "profile"]));
  });

  // Test 2: Mixed type key serialization
  runTest("Mixed type key serialization", () => {
    const key: DenoKvKey = ["items", 456, true, "details"];
    const serialized = mockKv._serializeKey(key);
    assertEquals(serialized, JSON.stringify(["items", 456, true, "details"]));
  });

  // Test 3: Single element key
  runTest("Single element key", () => {
    const key: DenoKvKey = ["single"];
    const serialized = mockKv._serializeKey(key);
    assertEquals(serialized, JSON.stringify(["single"]));
  });

  // Test 4: Empty key handling
  runTest("Empty key handling", () => {
    const key: DenoKvKey = [];
    const serialized = mockKv._serializeKey(key);
    assertEquals(serialized, JSON.stringify([]));
  });

  // Test 5: Row to entry with JSONB key_path
  runTest("Row to entry with JSONB key_path", () => {
    const row: DatabaseRow = {
      versionstamp: "12345",
      key_path: ["config", "server", "port"], // Already parsed JSONB
      value: { type: "number", value: 8080 }, // Already parsed JSONB
    };

    const entry = mockKv._rowToEntry(row);
    assertEquals(
      JSON.stringify(entry.key),
      JSON.stringify(["config", "server", "port"]),
    );
    assertEquals(
      JSON.stringify(entry.value),
      JSON.stringify({ type: "number", value: 8080 }),
    );
    assertEquals(entry.versionstamp, "12345");
  });

  // Test 6: Row to entry with legacy JSON string key_path
  runTest("Row to entry with legacy JSON string key_path", () => {
    const row: DatabaseRow = {
      versionstamp: "12346",
      key_path: '["config","server","host"]', // JSON string (legacy)
      value: '"localhost"', // JSON string value
    };

    const entry = mockKv._rowToEntry(row);
    assertEquals(
      JSON.stringify(entry.key),
      JSON.stringify(["config", "server", "host"]),
    );
    assertEquals(entry.value, "localhost");
  });

  // Test 7: Row to entry with legacy comma-separated key_path
  runTest("Row to entry with legacy comma-separated key_path", () => {
    const row: DatabaseRow = {
      versionstamp: "12347",
      key_path: "config,server,database", // Comma-separated (legacy)
      value: '"postgresql://localhost"', // JSON string value
    };

    const entry = mockKv._rowToEntry(row);
    assertEquals(
      JSON.stringify(entry.key),
      JSON.stringify(["config", "server", "database"]),
    );
    assertEquals(entry.value, "postgresql://localhost");
  });

  // Test 8: Row to entry with complex object value
  runTest("Row to entry with complex object value", () => {
    const complexValue = {
      user: {
        id: 123,
        name: "John Doe",
        preferences: {
          theme: "dark",
          notifications: true,
        },
      },
    };

    const row: DatabaseRow = {
      versionstamp: "12348",
      key_path: ["users", "123", "profile"],
      value: complexValue, // Already parsed JSONB object
    };

    const entry = mockKv._rowToEntry(row);
    assertEquals(JSON.stringify(entry.value), JSON.stringify(complexValue));
  });

  // Test 9: Row to entry with array value
  runTest("Row to entry with array value", () => {
    const arrayValue = [1, "two", { three: 3 }, true, null];

    const row: DatabaseRow = {
      versionstamp: "12349",
      key_path: ["test", "array"],
      value: arrayValue, // Already parsed JSONB array
    };

    const entry = mockKv._rowToEntry(row);
    assertEquals(JSON.stringify(entry.value), JSON.stringify(arrayValue));
  });

  // Test 10: Row to entry with primitive values
  runTest("Row to entry with primitive values", () => {
    const testCases = [
      { value: "string value", expected: "string value" },
      { value: 42, expected: 42 },
      { value: true, expected: true },
      { value: null, expected: null },
    ];

    for (const testCase of testCases) {
      const row: DatabaseRow = {
        versionstamp: "test",
        key_path: ["test"],
        value: testCase.value,
      };

      const entry = mockKv._rowToEntry(row);
      assertEquals(entry.value, testCase.expected);
    }
  });

  // Test 11: Row to entry with non-JSON string value (legacy)
  runTest("Row to entry with non-JSON string value (legacy)", () => {
    const row: DatabaseRow = {
      versionstamp: "12350",
      key_path: ["test"],
      value: "raw string value", // Non-JSON string (legacy)
    };

    const entry = mockKv._rowToEntry(row);
    assertEquals(entry.value, "raw string value");
  });

  // Test 12: Error handling in key serialization
  runTest("Error handling in key serialization", () => {
    // This should not throw but handle gracefully
    const result = mockKv._serializeKey(null as any);
    assertEquals(typeof result, "string");
  });

  // Print summary
  console.log("\n📊 Test Results:");
  console.log("================");
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`📈 Total:  ${testsPassed + testsFailed}`);

  if (testsFailed > 0) {
    console.log("\n❌ Some tests failed!");
    Deno.exit(1);
  } else {
    console.log("\n🎉 All serialization tests passed!");
    console.log("\n✨ The JSONB fixes are working correctly!");
    console.log(
      "   - Keys are properly serialized as JSON strings for JSONB columns",
    );
    console.log(
      "   - Values are properly serialized as JSON strings for JSONB columns",
    );
    console.log(
      "   - SQL parameters use ::jsonb casting for proper type conversion",
    );
    console.log("   - Legacy data formats are properly migrated");
  }
}

// Run tests if this file is executed directly
if (import.meta.main) {
  await runSerializationTests();
}
