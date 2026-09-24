-- Tenant isolation — composite (tenant_id, id) covering indexes.
-- ---------------------------------------------------------------------------
-- Every scoped read filters by tenant_id and pages/orders by the primary key
-- (see lib/tenant-scope.ts). A composite index leading with tenant_id serves
-- those access paths far better than the bare single-column index added by
-- 2026-11-07-tenant-data-isolation.sql. This migration adds
-- `idx_<table>_tenant_id` (tenant_id, id) to every table in the current schema
-- that carries BOTH a `tenant_id` and an `id` column and does not already have
-- the index. It mirrors the runtime self-heal in lib/tenant-ensure.ts, so a DB
-- that never runs this file still converges at boot.
--
-- Idempotent and data-safe: adds indexes only, never drops the existing
-- single-column index and never touches data.

DELIMITER $$

DROP PROCEDURE IF EXISTS `muenot_add_tenant_composite_indexes` $$
CREATE PROCEDURE `muenot_add_tenant_composite_indexes`()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE tbl VARCHAR(128);
  DECLARE idx_name VARCHAR(160);
  DECLARE cur CURSOR FOR
    SELECT c.TABLE_NAME
      FROM information_schema.COLUMNS c
      JOIN information_schema.COLUMNS c2
        ON c2.TABLE_SCHEMA = c.TABLE_SCHEMA
       AND c2.TABLE_NAME = c.TABLE_NAME
       AND c2.COLUMN_NAME = 'id'
     WHERE c.TABLE_SCHEMA = DATABASE()
       AND c.COLUMN_NAME = 'tenant_id'
       AND c.TABLE_NAME <> 'tenants';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO tbl;
    IF done = 1 THEN
      LEAVE read_loop;
    END IF;

    SET idx_name = CONCAT('idx_', tbl, '_tenant_id');

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx_name
    ) THEN
      SET @ddl = CONCAT('ALTER TABLE `', tbl, '` ADD KEY `', idx_name, '` (`tenant_id`, `id`)');
      PREPARE stmt FROM @ddl;
      EXECUTE stmt;
      DEALLOCATE PREPARE stmt;
    END IF;
  END LOOP;
  CLOSE cur;
END $$

DELIMITER ;

CALL `muenot_add_tenant_composite_indexes`();
DROP PROCEDURE IF EXISTS `muenot_add_tenant_composite_indexes`;
