# PostgreSQL KV JSONB Fixes

This document describes the fixes implemented to resolve "invalid input syntax for type json" errors in the PostgreSQL KV wrapper for Deno Deploy.

## Problem Description

The original PostgreSQL KV implementation was encountering JSON parsing errors during Deno Deploy startup:

```
[PG-KV] Error in get operation: {
  key: [ "config", "server.port" ],
  error: "invalid input syntax for type json"
}
```

### Root Cause

The issue was caused by a mismatch between how data was being stored and retrieved from PostgreSQL JSONB columns:

1. **Double JSON Encoding**: The code was calling `JSON.stringify()` on keys and values before inserting them into JSONB columns, causing PostgreSQL to try to parse JSON strings as JSON objects.

2. **Type Mismatch**: PostgreSQL JSONB columns expect actual JSON objects/arrays, not JSON strings. When a JSON string is inserted into a JSONB column, PostgreSQL tries to parse it again, leading to parsing errors.

3. **Legacy Data**: Existing data might have been stored in different formats (comma-separated keys, JSON strings) that needed migration.

## Solution Overview

The fix involved three main changes:

### 1. Direct JSONB Storage

**Before:**
```typescript
const serializedKey = JSON.stringify(key);      // Creates JSON string
const serializedValue = JSON.stringify(value);  // Creates JSON string
await pool.query('INSERT INTO deno_kv (key_path, value) VALUES ($1, $2)', 
  [serializedKey, serializedValue]);  // PostgreSQL tries to parse JSON strings as text
```

**After:**
```typescript
const serializedKey = JSON.stringify(key);      // Creates proper JSON string
const serializedValue = JSON.stringify(value);  // Creates proper JSON string
await pool.query('INSERT INTO deno_kv (key_path, value) VALUES ($1::jsonb, $2::jsonb)', 
  [serializedKey, serializedValue]);  // ::jsonb casting ensures proper JSONB conversion
```

### 2. Improved Data Retrieval

The `_rowToEntry` method now handles multiple data formats:

```typescript
private _rowToEntry<T>(row: DatabaseRow): KvEntry<T> {
  let parsedKey;
  
  // Check if key_path is already a parsed object/array (JSONB column)
  if (typeof row.key_path === "object" && row.key_path !== null) {
    parsedKey = row.key_path;  // Already parsed by PostgreSQL
  } else if (typeof row.key_path === "string") {
    // Handle legacy formats
    try {
      parsedKey = JSON.parse(row.key_path);  // JSON string format
    } catch {
      // Comma-separated format
      parsedKey = row.key_path.includes(",") 
        ? row.key_path.split(",") 
        : [row.key_path];
    }
  }
  
  // Similar logic for values...
}
```

### 3. Automatic Legacy Data Migration

A migration function automatically converts existing data to the new format by recreating the table structure:

```typescript
async function migrateLegacyData(pool: Pool): Promise<void> {
  // Backup existing data
  await pool.query(`CREATE TABLE deno_kv_backup AS SELECT * FROM deno_kv`);
  
  // Create temp table with text columns
  await pool.query(`CREATE TEMP TABLE deno_kv_temp (...)`);
  
  // Copy all data as text, then migrate with proper JSONB conversion
  await pool.query(`
    INSERT INTO deno_kv (key_path, value, ...)
    SELECT
      CASE
        WHEN key_path_raw ~ '^\\[.*\\]$' THEN key_path_raw::jsonb
        WHEN key_path_raw ~ ',' THEN ('["' || replace(key_path_raw, ',', '","') || '"]')::jsonb
        ELSE ('["' || key_path_raw || '"]')::jsonb
      END as key_path,
      -- Similar logic for values...
    FROM deno_kv_temp
  `);
}
```

## Database Schema

The PostgreSQL schema uses JSONB columns for optimal performance and native JSON support:

```sql
CREATE TABLE IF NOT EXISTS deno_kv (
  versionstamp BIGSERIAL PRIMARY KEY,
  key_path JSONB NOT NULL,           -- Stores arrays like ["config", "server", "port"]
  value JSONB NOT NULL,              -- Stores any JSON-serializable data
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS deno_kv_key_path_idx ON deno_kv (key_path);
```

## Changes Made

### Files Modified

1. **`src/utils/pg-kv.ts`** - Main implementation fixes
   - Modified `_serializeKey()` to return arrays instead of JSON strings
   - Updated `_rowToEntry()` to handle multiple data formats
   - Fixed all CRUD operations (get, set, delete, list)
   - Updated atomic operations
   - Added legacy data migration

### Backward Compatibility

The implementation maintains backward compatibility with existing data:

- **Legacy comma-separated keys**: `"config,server,port"` → `["config", "server", "port"]`
- **Legacy JSON string values**: `"\"some value\""` → `"some value"`
- **Mixed formats**: Handles both old and new formats during retrieval

### Performance Improvements

JSONB storage provides several advantages:

1. **Native JSON Operations**: PostgreSQL can perform native JSON operations on data
2. **Better Indexing**: JSONB columns support more efficient indexing
3. **Reduced Parsing**: No double JSON parsing overhead
4. **Type Safety**: PostgreSQL validates JSON structure automatically

## Testing

### Unit Tests

Run the serialization tests to verify the fixes:

```bash
deno run --allow-all test-serialization.ts
```

### Integration Tests

For full database testing (requires PostgreSQL):

```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Run integration tests
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/abracadabra_test \
  deno run --allow-all test-pg-kv.ts

# Cleanup
docker-compose -f docker-compose.test.yml down
```

## Migration Guide

### For Existing Deployments

The migration is automatic when the server starts. However, for large datasets, you may want to:

1. **Backup your database** before updating
2. **Monitor migration logs** during first startup
3. **Verify data integrity** after migration

### Manual Migration (if needed)

If automatic migration fails, you can run manual SQL commands:

```sql
-- Create backup
CREATE TABLE deno_kv_backup AS SELECT * FROM deno_kv;

-- If simple UPDATE migration fails, use table recreation approach
CREATE TEMP TABLE deno_kv_temp AS SELECT 
  versionstamp, key_path::text as key_path_raw, value::text as value_raw, 
  expires_at, created_at, updated_at FROM deno_kv;

DELETE FROM deno_kv;

INSERT INTO deno_kv (key_path, value, expires_at, created_at, updated_at)
SELECT
  CASE
    WHEN key_path_raw ~ '^\\[.*\\]$' THEN key_path_raw::jsonb
    WHEN key_path_raw ~ ',' THEN ('["' || replace(key_path_raw, ',', '","') || '"]')::jsonb
    ELSE ('["' || key_path_raw || '"]')::jsonb
  END,
  CASE
    WHEN value_raw ~ '^[\\[\\{].*[\\]\\}]$' THEN value_raw::jsonb
    WHEN value_raw ~ '^".*"$' THEN value_raw::jsonb
    ELSE ('"' || replace(value_raw, '"', '\\"') || '"')::jsonb
  END,
  expires_at, created_at, updated_at
FROM deno_kv_temp;
```

## Error Handling

The implementation includes robust error handling:

- **Connection failures**: Graceful fallback and error reporting
- **Migration failures**: Non-blocking (server continues with existing data)
- **Data format issues**: Automatic format detection and conversion
- **Type mismatches**: Fallback to string representation
- **SQL type casting**: Explicit `::jsonb` casting prevents parameter binding issues
- **Corrupted data recovery**: Table recreation strategy handles severely corrupted data

## Monitoring

Key log messages to monitor:

- `[PG-KV] Database schema setup completed successfully` - Setup OK
- `[PG-KV] Found X legacy records, starting migration...` - Migration in progress
- `[PG-KV] Legacy data migration completed successfully` - Migration OK
- `[PG-KV] Error in get operation:` - Data access issues

## Benefits

1. **Eliminates JSON parsing errors** on Deno Deploy
2. **Proper JSONB type casting** with `::jsonb` parameter binding
3. **Robust data migration** that handles corrupted existing data
4. **Maintains backward compatibility** with existing data
5. **Provides automatic migration** for legacy formats
6. **Enables advanced querying** with PostgreSQL JSON operators

## Future Considerations

- **Advanced JSON Queries**: The JSONB format enables complex queries using PostgreSQL's JSON operators
- **Indexing Strategies**: Consider adding GIN indexes on JSONB columns for better query performance
- **Monitoring**: Add metrics for migration success rates and query performance
- **Cleanup**: Consider removing legacy format support after successful migration

This fix ensures the Abracadabra Server works reliably on Deno Deploy with PostgreSQL as the KV backend.