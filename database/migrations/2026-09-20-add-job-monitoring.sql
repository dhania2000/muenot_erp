-- SPEC 43: preserve unknown for historical jobs; new producers record source.
-- Idempotent, including when the runtime schema initializer ran first.
SET @monitor_column_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema=DATABASE() AND table_name='platform_background_jobs' AND column_name='trigger_source');
SET @monitor_sql = IF(@monitor_column_exists=0,
  'ALTER TABLE platform_background_jobs ADD COLUMN trigger_source VARCHAR(30) NOT NULL DEFAULT ''unknown''',
  'SELECT 1');
PREPARE monitor_statement FROM @monitor_sql;
EXECUTE monitor_statement;
DEALLOCATE PREPARE monitor_statement;
