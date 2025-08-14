-- PostgreSQL KV Backup Table Cleanup Script
-- This script helps clean up multiple backup tables created during migration

-- First, let's see what tables we have
-- Run this to see all tables related to deno_kv:
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'deno_kv%'
ORDER BY table_name;

-- Check the main table (this should have your current data)
-- Uncomment to see row count in main table:
-- SELECT COUNT(*) as main_table_rows FROM deno_kv;

-- Check if migration marker exists (should show 1 row if migration completed)
-- Uncomment to check:
-- SELECT * FROM deno_kv WHERE key_path = '["_migration","completed"]'::jsonb;

-- =============================================================================
-- CLEANUP COMMANDS
-- =============================================================================

-- Option 1: DROP ALL timestamped backup tables (recommended)
-- This will remove all tables like deno_kv_backup_1731589234567
-- WARNING: This will permanently delete the backup data!

-- Generate DROP commands for all timestamped backup tables:
SELECT 'DROP TABLE IF EXISTS ' || table_name || ';' as drop_command
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name ~ '^deno_kv_backup_[0-9]+$'
ORDER BY table_name;

-- Copy the output from above and execute each DROP command manually
-- OR uncomment the lines below to drop them automatically:

/*
-- Auto-drop all timestamped backup tables (DANGEROUS - use with caution!)
DO $$
DECLARE
    table_name_var TEXT;
BEGIN
    FOR table_name_var IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ~ '^deno_kv_backup_[0-9]+$'
    LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || table_name_var;
        RAISE NOTICE 'Dropped table: %', table_name_var;
    END LOOP;
END $$;
*/

-- =============================================================================
-- Option 2: Keep one clean backup table
-- =============================================================================

-- If you want to keep one backup, first create a clean one:
-- DROP TABLE IF EXISTS deno_kv_backup;
-- CREATE TABLE deno_kv_backup AS SELECT * FROM deno_kv WHERE key_path != '["_migration","completed"]'::jsonb;

-- Then drop all the timestamped ones using Option 1 above

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- After cleanup, verify you only have the tables you want:
SELECT table_name,
       pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'deno_kv%'
ORDER BY table_name;

-- Verify your main table still has data:
-- SELECT COUNT(*) as remaining_rows FROM deno_kv;

-- =============================================================================
-- SUMMARY OF TABLES
-- =============================================================================

-- After cleanup, you should have:
-- 1. deno_kv                 <- Main table with your data (DO NOT DELETE)
-- 2. deno_kv_backup          <- Optional: One clean backup (safe to delete if not needed)
--
-- You should NOT have:
-- - deno_kv_backup_1731589234567 (or similar timestamped tables)
-- - Multiple backup tables
