-- Harden hr_leave_quota_history into a traceable, immutable transaction ledger.
--
-- These statements are applied idempotently at runtime by ensureLeaveSchema()
-- in lib/hr-leave.ts (columns are added only when missing, legacy rows are
-- backfilled, and the LQE sequence is seeded past the highest event id). This
-- file documents the resulting shape for reference and fresh installs.

-- Stable, human-readable, server-generated event id (e.g. LQE-000123).
ALTER TABLE hr_leave_quota_history ADD COLUMN quota_event_id VARCHAR(40) DEFAULT NULL;
-- Source channel: System / Leave Request / Adjustment / Accrual / Carry Forward / Expiry / Import.
ALTER TABLE hr_leave_quota_history ADD COLUMN source VARCHAR(30) DEFAULT NULL;
-- Links a reversal row back to the quota_event_id of the event it reverses.
ALTER TABLE hr_leave_quota_history ADD COLUMN reversal_of VARCHAR(40) DEFAULT NULL;

-- Backfill legacy rows deterministically from the primary key (unique by design).
UPDATE hr_leave_quota_history
  SET quota_event_id = CONCAT('LQE-', LPAD(event_id, 6, '0'))
  WHERE quota_event_id IS NULL OR quota_event_id = '';

UPDATE hr_leave_quota_history SET source = CASE event_type
    WHEN 'accrual' THEN 'Accrual'
    WHEN 'carry_forward' THEN 'Carry Forward'
    WHEN 'expiry' THEN 'Expiry'
    WHEN 'leave_approved' THEN 'Leave Request'
    WHEN 'leave_reversed' THEN 'Leave Request'
    WHEN 'adjustment' THEN 'Adjustment'
    WHEN 'reversal' THEN 'Adjustment'
    ELSE 'System' END
  WHERE source IS NULL OR source = '';

-- Seed the shared record-id sequence past the highest existing event id so
-- generated LQE ids can never collide with the backfilled ones.
INSERT INTO record_id_sequences (prefix, next_number)
  SELECT 'LQE', COALESCE(MAX(event_id), 0) FROM hr_leave_quota_history
  ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

-- Uniqueness + lookup indexes.
ALTER TABLE hr_leave_quota_history ADD UNIQUE KEY uq_quota_event_id (quota_event_id);
ALTER TABLE hr_leave_quota_history ADD INDEX idx_quota_reference (reference);
ALTER TABLE hr_leave_quota_history ADD INDEX idx_quota_reversal_of (reversal_of);
