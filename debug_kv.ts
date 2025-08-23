const kv = await Deno.openKv("./data/abracadabra.db");

console.log("=== KV Store Contents ===");

for await (const entry of kv.list({ prefix: ["users"] })) {
  console.log(
    "Key:",
    entry.key,
    "Value type:",
    typeof entry.value,
    "Has value:",
    !!entry.value,
  );

  if (typeof entry.value === "object" && entry.value) {
    const obj = entry.value as any;
    if ("username" in obj) {
      console.log(
        "  -> User:",
        obj.username,
        "isActive:",
        obj.isActive,
        "hasPassword:",
        !!obj.hashedPassword,
      );
    }
  } else {
    console.log("  -> Index value:", entry.value);
  }
}

console.log("\n=== Checking specific lookups ===");

// Check specific username index
const usernameIndex = await kv.get(["users", "by_username", "admin"]);
console.log('Username index for "admin":', usernameIndex.value);

// Check specific email index
const emailIndex = await kv.get(["users", "by_email", "admin@example.com"]);
console.log('Email index for "admin@example.com":', emailIndex.value);

// Try to find user by direct ID lookup if we have one
if (usernameIndex.value) {
  const userById = await kv.get(["users", usernameIndex.value]);
  console.log("User by ID lookup:", userById.value ? "Found" : "Not found");
  if (userById.value) {
    const user = userById.value as any;
    console.log("  -> Username:", user.username, "Email:", user.email);
  }
}

await kv.close();
