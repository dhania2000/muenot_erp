-- ===========================================================================
-- Recruitment unification: one candidate spine across both systems
--
-- The Recruitment module historically had two parallel worlds:
--
--   * The operational worksuite pipeline (recruit_jobs -> recruit_applications
--     -> recruit_offers -> hr_employees, plus recruit_interviews / recruit_bgv_
--     checks / recruit_reference_checks / recruit_prejoining_tasks), keyed on
--     recruit_applications.application_id.
--
--   * The config-driven Recruitment modules (recruitment_candidates a.k.a.
--     "Candidate Master", recruitment_screening, recruitment_interviews,
--     recruitment_assessments, recruitment_selections, recruitment_interview_
--     feedback, recruitment_background_verification, recruitment_reference_
--     checks, recruitment_pre_joining), keyed on a free-text candidate_id /
--     candidate_name and NOT linked to the operational application.
--
-- This migration wires the two together with the canonical person being the
-- Candidate Master (recruitment_candidates), while every stage record links to
-- the operational application via application_id:
--
--   recruit_applications.candidate_master_id  -> recruitment_candidates.candidate_id
--   recruitment_candidates.application_id      -> recruit_applications.application_id (latest)
--   <stage tables>.application_id              -> recruit_applications.application_id
--
-- All statements are idempotent (MariaDB IF NOT EXISTS) and safe to re-run.
-- The application self-heals the same schema at runtime
-- (lib/recruit-unification-db.ts -> ensureUnificationSchema), so applying this
-- file is optional but recommended.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Canonical person <-> operational application cross-links
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS candidate_master_id VARCHAR(191) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD INDEX IF NOT EXISTS idx_app_candidate_master (candidate_master_id);

ALTER TABLE recruitment_candidates
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_candidates
  ADD COLUMN IF NOT EXISTS norm_email VARCHAR(255) DEFAULT NULL;
ALTER TABLE recruitment_candidates
  ADD COLUMN IF NOT EXISTS norm_phone VARCHAR(20) DEFAULT NULL;
ALTER TABLE recruitment_candidates
  ADD INDEX IF NOT EXISTS idx_cand_application (application_id);
ALTER TABLE recruitment_candidates
  ADD INDEX IF NOT EXISTS idx_cand_norm_email (norm_email);
ALTER TABLE recruitment_candidates
  ADD INDEX IF NOT EXISTS idx_cand_norm_phone (norm_phone);

-- ---------------------------------------------------------------------------
-- Stage tables gain an application_id link back to the operational pipeline.
-- (They already carry candidate_id / candidate_name from their module config.)
-- ---------------------------------------------------------------------------
ALTER TABLE recruitment_screening
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_screening
  ADD INDEX IF NOT EXISTS idx_scr_application (application_id);

ALTER TABLE recruitment_interviews
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_interviews
  ADD INDEX IF NOT EXISTS idx_rint_application (application_id);

ALTER TABLE recruitment_assessments
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_assessments
  ADD INDEX IF NOT EXISTS idx_asm_application (application_id);

ALTER TABLE recruitment_selections
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_selections
  ADD INDEX IF NOT EXISTS idx_sel_application (application_id);

ALTER TABLE recruitment_interview_feedback
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_interview_feedback
  ADD INDEX IF NOT EXISTS idx_ifb_application (application_id);

ALTER TABLE recruitment_background_verification
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_background_verification
  ADD INDEX IF NOT EXISTS idx_rbgv_application (application_id);

ALTER TABLE recruitment_reference_checks
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_reference_checks
  ADD INDEX IF NOT EXISTS idx_rref_application (application_id);

ALTER TABLE recruitment_pre_joining
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_pre_joining
  ADD INDEX IF NOT EXISTS idx_prj_application (application_id);
