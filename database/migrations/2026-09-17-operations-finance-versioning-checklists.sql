-- =============================================================================
-- Operations Module — Finance derivation, SOP versioning, Checklist items,
-- Client-approval audit.
-- -----------------------------------------------------------------------------
-- This migration is purely ADDITIVE. It never drops or rewrites an existing
-- Operations table, so all current data and pages are preserved.
--
--   * operations_projects gains a single `budget_amount` planning field so the
--     Budget vs Actual report has one authoritative budget source (no duplicate
--     Finance/budget system is introduced).
--   * operations_sop_versions keeps an immutable history snapshot every time an
--     SOP is created or edited, so previous versions are never lost (Phase 33).
--   * operations_checklist_items stores per-item Pending/Completed/Not
--     Applicable states; the parent checklist's completion % is auto-derived
--     from these rows (Phases 34-35).
--   * operations_client_approvals gains `decided_by` / `decided_at` so every
--     approve/reject decision is stamped with the acting user + timestamp
--     automatically (Phase 40).
--
-- MySQL has no "ADD COLUMN IF NOT EXISTS"; the application self-heals these
-- columns at runtime via lib/operations-ensure.ts using information_schema, so
-- an install that has not run this file degrades gracefully. New tables use
-- IF NOT EXISTS and are safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 45 — Projects: authoritative planning budget for Budget vs Actual
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_projects`
  ADD COLUMN `budget_amount` DECIMAL(14,2) NULL AFTER `billing_model`;

-- ---------------------------------------------------------------------------
-- Phase 33 — SOP version history (immutable snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_sop_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sop_id INT NOT NULL,
  sop_code VARCHAR(128) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  effective_date DATE DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  next_review_date DATE DEFAULT NULL,
  approval_status VARCHAR(64) DEFAULT NULL,
  document_url VARCHAR(512) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  change_type VARCHAR(32) DEFAULT NULL,
  snapshot_by INT UNSIGNED DEFAULT NULL,
  snapshot_by_name VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sop_versions_sop (sop_id),
  KEY idx_sop_versions_created (created_at)
);

-- ---------------------------------------------------------------------------
-- Phases 34-35 — Checklist items (drive the parent checklist completion %)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_checklist_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  checklist_id INT NOT NULL,
  item_text VARCHAR(512) DEFAULT NULL,
  sort_order INT DEFAULT NULL,
  item_status VARCHAR(32) DEFAULT 'Pending',
  completed_by VARCHAR(255) DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_checklist_items_checklist (checklist_id)
);

-- ---------------------------------------------------------------------------
-- Phase 40 — Client approvals: audit stamp on decision
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_client_approvals`
  ADD COLUMN `decided_by` VARCHAR(255) NULL AFTER `decision_date`,
  ADD COLUMN `decided_at` DATETIME NULL AFTER `decided_by`;
