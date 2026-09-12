-- =====================================================================
-- HR Email Hub — Phase 2: event-driven automation config
-- ---------------------------------------------------------------------
-- Stores per-event automation rules for the HR communication engine:
-- which HR workflow events send an automated email, which template they
-- use (NULL = built-in default in lib/hr-email-automation.ts), and whether
-- the reporting manager is auto-CC'd.
--
-- This table is also created + seeded idempotently at runtime by
-- ensureHrEmailAutomationSchema() in lib/hr-email-automation.ts, so the
-- feature keeps working even if this migration has not been run manually.
-- =====================================================================

CREATE TABLE IF NOT EXISTS hr_email_automations (
  event_key   VARCHAR(60)     NOT NULL PRIMARY KEY,
  enabled     TINYINT(1)      NOT NULL DEFAULT 1,
  template_id BIGINT UNSIGNED NULL,
  cc_manager  TINYINT(1)      NOT NULL DEFAULT 0,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the known event catalog (matches HR_EMAIL_EVENTS). cc_manager mirrors
-- each event's ccManagerDefault; INSERT IGNORE keeps existing overrides intact.
INSERT IGNORE INTO hr_email_automations (event_key, enabled, cc_manager) VALUES
  ('leave_submitted',        1, 1),
  ('leave_approved',         1, 1),
  ('leave_rejected',         1, 1),
  ('leave_cancelled',        1, 0),
  ('shift_change_submitted', 1, 1),
  ('shift_change_approved',  1, 1),
  ('shift_change_rejected',  1, 0),
  ('promotion_effective',    1, 1),
  ('support_ticket_created', 1, 0),
  ('offboarding_initiated',  1, 0),
  ('offboarding_completed',  1, 0);
