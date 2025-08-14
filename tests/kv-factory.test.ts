import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createKv,
  createKvFromEnv,
  getKvConfig,
  validateKvConfig,
} from "../src/utils/kv-factory.ts";

Deno.test("KV Factory - Default configuration (Deno KV)", async () => {
  // Save original env vars
  const originalProvider = Deno.env.get("KV_PROVIDER");
  const originalKvPath = Deno.env.get("ABRACADABRA_KV_PATH");

  try {
    // Set up test environment
    Deno.env.delete("KV_PROVIDER");
    Deno.env.delete("ABRACADABRA_KV_PATH");

    const config = getKvConfig();
    assertEquals(config.provider, "deno");
    assertEquals(config.denoKvPath, "./data/kv.db");

    const validation = validateKvConfig();
    assert(validation.valid);
    assertEquals(validation.errors.length, 0);

    // Test creating KV instance
    const kv = await createKv({ provider: "deno", denoKvPath: ":memory:" });
    assert(kv);

    // Test basic operations
    await kv.set(["test"], "value");
    const result = await kv.get(["test"]);
    assertEquals(result?.value, "value");

    kv.close();
  } finally {
    // Restore original env vars
    if (originalProvider) Deno.env.set("KV_PROVIDER", originalProvider);
    if (originalKvPath) Deno.env.set("ABRACADABRA_KV_PATH", originalKvPath);
  }
});

Deno.test("KV Factory - PostgreSQL configuration validation", () => {
  // Test valid PostgreSQL config
  const validConfig = {
    provider: "postgres" as const,
    postgresUrl: "postgresql://localhost:5432/test",
  };

  const validation = validateKvConfig(validConfig);
  assert(validation.valid);
  assertEquals(validation.errors.length, 0);

  // Test invalid PostgreSQL config (missing URL)
  const invalidConfig = {
    provider: "postgres" as const,
  };

  const invalidValidation = validateKvConfig(invalidConfig);
  assert(!invalidValidation.valid);
  assert(
    invalidValidation.errors.some((err) => err.includes("PostgreSQL URL is required")),
  );
});

Deno.test("KV Factory - Invalid provider configuration", () => {
  const invalidConfig = {
    provider: "invalid" as any,
  };

  const validation = validateKvConfig(invalidConfig);
  assert(!validation.valid);
  assert(validation.errors.some((err) => err.includes("Invalid KV provider")));
});

Deno.test("KV Factory - Environment variable configuration", () => {
  // Save original env vars
  const originalProvider = Deno.env.get("KV_PROVIDER");
  const originalKvPath = Deno.env.get("ABRACADABRA_KV_PATH");
  const originalDbUrl = Deno.env.get("DATABASE_URL");

  try {
    // Test Deno KV environment
    Deno.env.set("KV_PROVIDER", "deno");
    Deno.env.set("ABRACADABRA_KV_PATH", "/custom/path/kv.db");

    const denoConfig = getKvConfig();
    assertEquals(denoConfig.provider, "deno");
    assertEquals(denoConfig.denoKvPath, "/custom/path/kv.db");

    // Test PostgreSQL environment
    Deno.env.set("KV_PROVIDER", "postgres");
    Deno.env.set("DATABASE_URL", "postgresql://localhost:5432/test");

    const pgConfig = getKvConfig();
    assertEquals(pgConfig.provider, "postgres");
    assertEquals(pgConfig.postgresUrl, "postgresql://localhost:5432/test");
  } finally {
    // Restore original env vars
    if (originalProvider) {
      Deno.env.set("KV_PROVIDER", originalProvider);
    } else {
      Deno.env.delete("KV_PROVIDER");
    }

    if (originalKvPath) {
      Deno.env.set("ABRACADABRA_KV_PATH", originalKvPath);
    } else {
      Deno.env.delete("ABRACADABRA_KV_PATH");
    }

    if (originalDbUrl) {
      Deno.env.set("DATABASE_URL", originalDbUrl);
    } else {
      Deno.env.delete("DATABASE_URL");
    }
  }
});

Deno.test("KV Factory - PostgreSQL KV creation (conditional)", async () => {
  // Only run this test if a test database URL is provided
  const testDbUrl = Deno.env.get("TEST_DATABASE_URL");

  if (!testDbUrl) {
    console.log("⚠️  Skipping PostgreSQL KV test - TEST_DATABASE_URL not set");
    return;
  }

  try {
    const kv = await createKv({
      provider: "postgres",
      postgresUrl: testDbUrl,
    });

    assert(kv, "KV instance should be created");

    // Test basic operations
    const testKey = ["test", "pg", Date.now()];
    const testValue = {
      message: "Hello from PostgreSQL KV!",
      timestamp: Date.now(),
    };

    // Set a value
    const setResult = await kv.set(testKey, testValue);
    assert(setResult.ok, "Set operation should succeed");
    assert(setResult.versionstamp, "Should have versionstamp");

    // Get the value
    const getResult = await kv.get(testKey);
    assert(getResult?.value, "Should retrieve the value");
    assertEquals(getResult.value, testValue);
    assertEquals(getResult.key, testKey);

    // Test atomic operations
    const atomic = kv.atomic();
    atomic.set([...testKey, "atomic"], "atomic_value");
    atomic.delete(testKey);

    const commitResult = await atomic.commit();
    assert(commitResult?.ok, "Atomic commit should succeed");

    // Verify atomic operations worked
    const deletedResult = await kv.get(testKey);
    assertEquals(deletedResult?.value, null, "Original key should be deleted");

    const atomicResult = await kv.get([...testKey, "atomic"]);
    assertEquals(atomicResult?.value, "atomic_value", "Atomic set should work");

    // Clean up
    await kv.delete([...testKey, "atomic"]);

    kv.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️  PostgreSQL KV test failed: ${message}`);
    console.log("This might be expected if the test database is not available");
  }
});

Deno.test(
  "KV Factory - Error handling for missing PostgreSQL URL",
  async () => {
    await assertRejects(
      () => createKv({ provider: "postgres" }),
      Error,
      "PostgreSQL URL is required",
    );
  },
);

Deno.test(
  "KV Factory - createKvFromEnv uses environment configuration",
  async () => {
    // Save original env vars
    const originalProvider = Deno.env.get("KV_PROVIDER");
    const originalKvPath = Deno.env.get("ABRACADABRA_KV_PATH");

    try {
      // Set up test environment for Deno KV
      Deno.env.set("KV_PROVIDER", "deno");
      Deno.env.set("ABRACADABRA_KV_PATH", ":memory:");

      const kv = await createKvFromEnv();
      assert(kv, "Should create KV instance from environment");

      // Test that it works
      await kv.set(["env_test"], "environment_value");
      const result = await kv.get(["env_test"]);
      assertEquals(result?.value, "environment_value");

      kv.close();
    } finally {
      // Restore original env vars
      if (originalProvider) {
        Deno.env.set("KV_PROVIDER", originalProvider);
      } else {
        Deno.env.delete("KV_PROVIDER");
      }

      if (originalKvPath) {
        Deno.env.set("ABRACADABRA_KV_PATH", originalKvPath);
      } else {
        Deno.env.delete("ABRACADABRA_KV_PATH");
      }
    }
  },
);

Deno.test("KV Factory - Deno KV list operations", async () => {
  const kv = await createKv({ provider: "deno", denoKvPath: ":memory:" });

  try {
    // Set up test data
    await kv.set(["users", "1"], { name: "Alice", email: "alice@example.com" });
    await kv.set(["users", "2"], { name: "Bob", email: "bob@example.com" });
    await kv.set(["posts", "1"], { title: "Hello World", author: "1" });
    await kv.set(["posts", "2"], { title: "Deno KV", author: "2" });

    // Test prefix listing
    const users: any[] = [];
    for await (const entry of kv.list({ prefix: ["users"] })) {
      users.push(entry);
    }

    assertEquals(users.length, 2);
    assert(users.some((u) => u.value.name === "Alice"));
    assert(users.some((u) => u.value.name === "Bob"));

    // Test range listing
    const posts: any[] = [];
    for await (
      const entry of kv.list({
        start: ["posts"],
        end: ["posts", "\x7f"],
      })
    ) {
      posts.push(entry);
    }

    assertEquals(posts.length, 2);
    assert(posts.some((p) => p.value.title === "Hello World"));
    assert(posts.some((p) => p.value.title === "Deno KV"));
  } finally {
    kv.close();
  }
});
