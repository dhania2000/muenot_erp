-- =============================================================================
-- SPEC 115 — CRM DEAL PIPELINE
-- =============================================================================
-- Configurable deal pipelines for the Sales CRM. A pipeline is an ordered list
-- of stages; each stage carries a default win probability and can be flagged as
-- the terminal Won / Lost stage or as requiring approval before a deal may be
-- closed from it. Deals live on a single row and carry expected value, owner,
-- team, close date, approval state and lost reason. Stage moves, wins, losses
-- and approvals are all funnelled through lib/sales/deal-pipeline.ts so there is
-- one source of truth.
--
-- This file mirrors the runtime self-heal in `ensureDealPipelineSchema()`
-- (lib/sales/deal-pipeline.ts). Keep the two in sync. Audit + in-app
-- notifications reuse the Sales tables created by `ensureLeadLifecycleSchema`
-- (sales_audit_log / sales_notifications), so no audit tables are declared here.
--
-- Conventions:
--   * InnoDB / utf8mb4.
--   * Idempotent: CREATE TABLE IF NOT EXISTS + a guarded default-pipeline seed,
--     safe to re-run.
--   * Child rows cascade-delete with their parent pipeline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pipelines — one row per configurable pipeline (supports multiple pipelines)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_pipelines (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_default  TINYINT(1)   NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_by  INT UNSIGNED DEFAULT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pipeline_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Stages — ordered stages within a pipeline, with default probability and the
-- Won / Lost / approval-gate flags
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_pipeline_stages (
  id                INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  pipeline_id       INT UNSIGNED     NOT NULL,
  name              VARCHAR(120)     NOT NULL,
  sort_order        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  probability       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_won            TINYINT(1)       NOT NULL DEFAULT 0,
  is_lost           TINYINT(1)       NOT NULL DEFAULT 0,
  requires_approval TINYINT(1)       NOT NULL DEFAULT 0,
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stage_pipeline (pipeline_id, sort_order),
  CONSTRAINT fk_stage_pipeline FOREIGN KEY (pipeline_id) REFERENCES sales_pipelines (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Deals — a single row per opportunity. Carries expected value, owner, team,
-- close date, approval workflow state and lost reason. Optimistic concurrency
-- via row_version; soft-deleted via archived_at.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_deals (
  id                    INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  deal_code             VARCHAR(30)   DEFAULT NULL,
  pipeline_id           INT UNSIGNED  NOT NULL,
  stage_id              INT UNSIGNED  NOT NULL,
  title                 VARCHAR(200)  NOT NULL,
  company_id            INT UNSIGNED  DEFAULT NULL,
  company_name          VARCHAR(200)  DEFAULT NULL,
  contact_person        VARCHAR(150)  DEFAULT NULL,
  owner_id              INT UNSIGNED  DEFAULT NULL,
  team_id               INT UNSIGNED  DEFAULT NULL,
  expected_value        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency              VARCHAR(8)    NOT NULL DEFAULT 'INR',
  probability           TINYINT UNSIGNED DEFAULT NULL,
  expected_close_date   DATE          DEFAULT NULL,
  status                ENUM('Open','Won','Lost')                 NOT NULL DEFAULT 'Open',
  approval_status       ENUM('None','Pending','Approved','Rejected') NOT NULL DEFAULT 'None',
  approval_note         VARCHAR(500)  DEFAULT NULL,
  approved_by           INT UNSIGNED  DEFAULT NULL,
  approval_requested_at DATETIME      DEFAULT NULL,
  approval_decided_at   DATETIME      DEFAULT NULL,
  won_at                DATETIME      DEFAULT NULL,
  won_value             DECIMAL(14,2) DEFAULT NULL,
  lost_at               DATETIME      DEFAULT NULL,
  lost_reason           VARCHAR(120)  DEFAULT NULL,
  lost_notes            TEXT          DEFAULT NULL,
  source_lead_id        INT UNSIGNED  DEFAULT NULL,
  notes                 TEXT          DEFAULT NULL,
  row_version           INT UNSIGNED  NOT NULL DEFAULT 1,
  archived_at           DATETIME      DEFAULT NULL,
  created_by            INT UNSIGNED  DEFAULT NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_deal_code (deal_code),
  KEY idx_deal_pipeline_stage (pipeline_id, stage_id),
  KEY idx_deal_owner (owner_id, status),
  KEY idx_deal_status (status, archived_at),
  CONSTRAINT fk_deal_pipeline FOREIGN KEY (pipeline_id) REFERENCES sales_pipelines (id),
  CONSTRAINT fk_deal_stage FOREIGN KEY (stage_id) REFERENCES sales_pipeline_stages (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Seed the default pipeline + its stages (only when no pipeline exists yet).
-- Mirrors DEFAULT_STAGES in lib/sales/deal-pipeline.ts.
-- -----------------------------------------------------------------------------
INSERT INTO sales_pipelines (name, description, is_default, is_active)
SELECT 'Sales Pipeline', 'Default deal pipeline', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM sales_pipelines);

INSERT INTO sales_pipeline_stages (pipeline_id, name, sort_order, probability, is_won, is_lost, requires_approval)
SELECT p.id, s.name, s.sort_order, s.probability, s.is_won, s.is_lost, s.requires_approval
FROM sales_pipelines p
JOIN (
  SELECT 'Qualification'  AS name, 0 AS sort_order, 10  AS probability, 0 AS is_won, 0 AS is_lost, 0 AS requires_approval
  UNION ALL SELECT 'Needs Analysis', 1, 25,  0, 0, 0
  UNION ALL SELECT 'Proposal',       2, 50,  0, 0, 0
  UNION ALL SELECT 'Negotiation',    3, 75,  0, 0, 1
  UNION ALL SELECT 'Closed Won',     4, 100, 1, 0, 0
  UNION ALL SELECT 'Closed Lost',    5, 0,   0, 1, 0
) s
WHERE p.is_default = 1
  AND NOT EXISTS (SELECT 1 FROM sales_pipeline_stages st WHERE st.pipeline_id = p.id);
