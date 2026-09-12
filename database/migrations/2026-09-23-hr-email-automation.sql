-- =====================================================================
-- HR Email Hub — Phase 2: event-driven automation
-- ---------------------------------------------------------------------
-- One row per automated HR email event (LEAVE_APPROVED, PROMOTION_EFFECTIVE,
-- ...). Each row decides whether the event fires, which hr_email_templates
-- row supplies subject/body (NULL => built-in default template baked into
-- lib/hr-email-automation.ts), and whether the reporting manager is CC'd.
--
-- The same table + seed rows are created idempotently at runtime by
-- ensureHrEmailAutomationSchema() in lib/hr-email-automation.ts, so the
-- feature works even if this migration is not run manually in phpMyAdmin.
-- =====================================================================

CREATE TABLE IF NOT EXISTS hr_email_automations (
  event_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  template_id BIGINT UNSIGNED NULL,
  cc_manager  TINYINT(1)   NOT NULL DEFAULT 0,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the known events (INSERT IGNORE keeps any admin overrides intact).
INSERT IGNORE INTO hr_email_automations (event_key, enabled, cc_manager) VALUES
  ('leave_submitted',         1, 1),
  ('leave_approved',          1, 1),
  ('leave_rejected',          1, 1),
  ('leave_cancelled',         1, 0),
  ('shift_change_submitted',  1, 1),
  ('shift_change_approved',   1, 1),
  ('shift_change_rejected',   1, 0),
  ('promotion_effective',     1, 1),
  ('support_ticket_created',  1, 0),
  ('offboarding_initiated',   1, 0),
  ('offboarding_completed',   1, 0);
