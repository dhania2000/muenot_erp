-- Journal Entries central-accounting upgrade (Phases 31–35).
--
-- Adds the cost-centre dimension to the two tables the manual journal engine
-- writes: journal_entries (the unposted voucher) and general_ledger (the posted
-- ledger line). Party and project columns already exist on both tables from
-- 2026-09-08-add-journal-ledger-reports.sql, so only cost_centre is new here.
--
-- The engine also applies these lazily at runtime (ensureManualJournalColumns in
-- lib/finance-journal.ts) so installs that never run this migration still
-- upgrade in place; this file keeps the schema self-documenting.
--
-- Idempotent ADD COLUMN via a temporary stored procedure (MySQL lacks
-- ADD COLUMN IF NOT EXISTS), mirroring 2026-09-30-purchase-bill-master-upgrade.sql.

DROP PROCEDURE IF EXISTS `__je_add_column`;
DELIMITER //
CREATE PROCEDURE `__je_add_column`(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = tbl AND column_name = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN ', ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL `__je_add_column`('journal_entries', 'cost_centre', 'cost_centre VARCHAR(120) DEFAULT NULL');
CALL `__je_add_column`('general_ledger',  'cost_centre', 'cost_centre VARCHAR(120) DEFAULT NULL');

-- Reversal link columns the engine also ensures lazily (see finance-journal.ts).
CALL `__je_add_column`('journal_entries', 'reversal_of', 'reversal_of VARCHAR(40) DEFAULT NULL');
CALL `__je_add_column`('journal_entries', 'reversed_by', 'reversed_by VARCHAR(40) DEFAULT NULL');

DROP PROCEDURE IF EXISTS `__je_add_column`;
