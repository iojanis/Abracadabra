const sourceDb = await Deno.openKv('./data/abracadabra.db');
const targetDb = await Deno.openKv('./data/kv.db');

console.log('🔄 Copying users from abracadabra.db to kv.db...');

let copiedCount = 0;

// Copy all user-related entries
for await (const entry of sourceDb.list({ prefix: ['users'] })) {
  console.log('Copying:', entry.key);
  await targetDb.set(entry.key, entry.value);
  copiedCount++;
}

console.log(`✅ Successfully copied ${copiedCount} user entries`);

// Verify the copy worked
console.log('\n🔍 Verifying copy...');
const adminIndex = await targetDb.get(['users', 'by_username', 'admin']);
console.log('Admin username index:', adminIndex.value ? 'Found' : 'Missing');

if (adminIndex.value) {
  const adminUser = await targetDb.get(['users', 'by_id', adminIndex.value as string]);
  console.log('Admin user record:', adminUser.value ? 'Found' : 'Missing');
  if (adminUser.value) {
    const user = adminUser.value as any;
    console.log('Admin details:', {
      username: user.username,
      email: user.email,
      isActive: user.isActive,
      hasPassword: !!user.hashedPassword
    });
  }
}

await sourceDb.close();
await targetDb.close();

console.log('✅ User copy completed successfully!');
