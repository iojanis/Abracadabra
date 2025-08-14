import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hash, PASSWORD_CONFIG, validatePasswordStrength, verify } from "../src/utils/password.ts";

Deno.test("Password Hashing - Basic functionality", async () => {
  const password = "testPassword123";

  // Hash the password
  const hashedPassword = await hash(password);

  // Hash should not be the same as the original password
  assertNotEquals(hashedPassword, password);

  // Hash should contain 3 parts separated by $
  const parts = hashedPassword.split("$");
  assertEquals(parts.length, 3);

  // First part should be the iterations count
  assertEquals(parseInt(parts[0]), PASSWORD_CONFIG.iterations);

  // Verify the password
  const isValid = await verify(hashedPassword, password);
  assert(isValid);
});

Deno.test("Password Hashing - Different passwords produce different hashes", async () => {
  const password1 = "password123";
  const password2 = "password456";

  const hash1 = await hash(password1);
  const hash2 = await hash(password2);

  // Different passwords should produce different hashes
  assertNotEquals(hash1, hash2);

  // Each password should only verify against its own hash
  assert(await verify(hash1, password1));
  assert(await verify(hash2, password2));
  assertFalse(await verify(hash1, password2));
  assertFalse(await verify(hash2, password1));
});

Deno.test("Password Hashing - Same password produces different hashes (salt)", async () => {
  const password = "samePassword123";

  const hash1 = await hash(password);
  const hash2 = await hash(password);

  // Same password should produce different hashes due to random salt
  assertNotEquals(hash1, hash2);

  // But both should verify correctly
  assert(await verify(hash1, password));
  assert(await verify(hash2, password));
});

Deno.test("Password Hashing - Invalid hash formats", async () => {
  const password = "testPassword123";

  // Test various invalid hash formats
  const invalidHashes = [
    "invalid",
    "100000$salt", // Missing hash part
    "invalid$salt$hash", // Invalid iterations
    "100000$$hash", // Empty salt
    "100000$salt$", // Empty hash
    "", // Empty string
  ];

  for (const invalidHash of invalidHashes) {
    const result = await verify(invalidHash, password);
    assertFalse(result, `Should return false for invalid hash: ${invalidHash}`);
  }
});

Deno.test("Password Hashing - Wrong password verification", async () => {
  const correctPassword = "correctPassword123";
  const wrongPassword = "wrongPassword123";

  const hashedPassword = await hash(correctPassword);

  // Correct password should verify
  assert(await verify(hashedPassword, correctPassword));

  // Wrong password should not verify
  assertFalse(await verify(hashedPassword, wrongPassword));

  // Empty password should not verify
  assertFalse(await verify(hashedPassword, ""));
});

Deno.test("Password Validation - Valid passwords", () => {
  const validPasswords = [
    "password123",
    "MySecurePass1",
    "TestPass99",
    "a1bcdefgh", // Exactly at minimum length
    "A".repeat(PASSWORD_CONFIG.maxLength - 1) + "1", // At maximum length
  ];

  for (const password of validPasswords) {
    const result = validatePasswordStrength(password);
    assert(
      result.valid,
      `Password should be valid: ${password}, errors: ${result.errors.join(", ")}`,
    );
    assertEquals(result.errors.length, 0);
  }
});

Deno.test("Password Validation - Invalid passwords", () => {
  const invalidPasswords = [
    { password: "short1", expectedError: "at least" }, // Too short
    { password: "A".repeat(PASSWORD_CONFIG.maxLength + 1), expectedError: "at most" }, // Too long
    { password: "passwordonly", expectedError: "letter and one number" }, // No numbers
    { password: "12345678", expectedError: "letter and one number" }, // No letters
    { password: "", expectedError: "at least" }, // Empty
  ];

  for (const { password, expectedError } of invalidPasswords) {
    const result = validatePasswordStrength(password);
    assertFalse(result.valid, `Password should be invalid: ${password}`);
    assert(result.errors.length > 0);
    assert(
      result.errors.some((error) => error.includes(expectedError)),
      `Expected error containing "${expectedError}", got: ${result.errors.join(", ")}`,
    );
  }
});

Deno.test("Password Hashing - Performance test", async () => {
  const password = "performanceTest123";
  const iterations = 5;

  const startTime = performance.now();

  // Hash multiple passwords
  const promises = [];
  for (let i = 0; i < iterations; i++) {
    promises.push(hash(password + i));
  }

  const hashes = await Promise.all(promises);

  // Verify all hashes
  const verifyPromises = [];
  for (let i = 0; i < iterations; i++) {
    verifyPromises.push(verify(hashes[i], password + i));
  }

  const results = await Promise.all(verifyPromises);

  const endTime = performance.now();
  const totalTime = endTime - startTime;

  // All verifications should succeed
  for (const result of results) {
    assert(result);
  }

  // Log performance info (not a test assertion, just for information)
  console.log(`Processed ${iterations} hash/verify cycles in ${totalTime.toFixed(2)}ms`);
  console.log(`Average time per cycle: ${(totalTime / iterations).toFixed(2)}ms`);

  // Basic performance check - should not take more than 30 seconds for 5 iterations
  assert(totalTime < 30000, `Performance test took too long: ${totalTime}ms`);
});

Deno.test("Password Hashing - Edge cases", async () => {
  // Test with special characters
  const specialPassword = "p@ssw0rd!@#$%^&*()";
  const hash1 = await hash(specialPassword);
  assert(await verify(hash1, specialPassword));

  // Test with unicode characters
  const unicodePassword = "пароль123🔐";
  const hash2 = await hash(unicodePassword);
  assert(await verify(hash2, unicodePassword));

  // Test with very long password (but within limits)
  const longPassword = "a1" + "b".repeat(PASSWORD_CONFIG.maxLength - 2);
  const hash3 = await hash(longPassword);
  assert(await verify(hash3, longPassword));
});

Deno.test("Password Hashing - Constant time comparison", async () => {
  // This test helps ensure we're not vulnerable to timing attacks
  const password = "testPassword123";
  const hashedPassword = await hash(password);

  const wrongPassword1 = "wrongPassword123";
  const wrongPassword2 = "x".repeat(password.length);

  // Measure verification times for different wrong passwords
  const iterations = 10;
  let time1 = 0;
  let time2 = 0;

  for (let i = 0; i < iterations; i++) {
    const start1 = performance.now();
    await verify(hashedPassword, wrongPassword1);
    time1 += performance.now() - start1;

    const start2 = performance.now();
    await verify(hashedPassword, wrongPassword2);
    time2 += performance.now() - start2;
  }

  const avgTime1 = time1 / iterations;
  const avgTime2 = time2 / iterations;

  // The timing difference should be relatively small (within 50% of each other)
  // This is not a perfect test for timing attacks, but gives us some confidence
  const timeDiffRatio = Math.abs(avgTime1 - avgTime2) / Math.max(avgTime1, avgTime2);
  assert(timeDiffRatio < 0.5, `Timing difference too large: ${timeDiffRatio}`);
});
