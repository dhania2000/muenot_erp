-- ===========================================================================
-- Recruitment unified flow — Phases 6-10 schema completion
--
-- Completes the single Requisition -> Approval -> Job -> Application spine so
-- there is exactly ONE recruitment data flow (requisition-hiring is canonical;
-- the old config-driven Job Requisitions page now redirects onto it).
--
-- Adds the genuinely-missing columns the spec calls for:
--
--   * Requisition approval audit trail:
--       Submitted By/At, Rejected By/At, Rejection Reason (Approved By/At and
--       approval_notes already exist from 2026-10-06). Plus an explicit
--       designation so it can flow through to the Job.
--
--   * Job: designation + hiring_manager (recruiter already exists).
--
--   * Application: requisition_id + campaign + recruiter, so every application
--       — internal or from the Career Site — enters the same pipeline and rolls
--       up to its requisition/campaign.
--
-- All statements are idempotent (IF NOT EXISTS) and safe to re-run. The
-- application layer also self-heals these via ensureUnifiedFlowSchema() /
-- ensureUnificationSchema(), so the code never crashes on a not-yet-migrated DB.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Requisition approval audit trail + designation
-- ---------------------------------------------------------------------------
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS submitted_by INT UNSIGNED DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS submitted_by_name VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS submitted_at DATETIME DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejected_by INT UNSIGNED DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejected_by_name VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejected_at DATETIME DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS designation VARCHAR(190) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- Job: designation + hiring manager (recruiter already present)
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_jobs
  ADD COLUMN IF NOT EXISTS designation VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruit_jobs
  ADD COLUMN IF NOT EXISTS hiring_manager VARCHAR(190) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- Application: requisition link + campaign + recruiter
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS campaign VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS recruiter VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD INDEX IF NOT EXISTS idx_jap_requisition (requisition_id);
