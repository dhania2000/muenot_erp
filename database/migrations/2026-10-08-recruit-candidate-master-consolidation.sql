-- ===========================================================================
-- Recruitment Phase 5: collapse the parallel candidate profile store
--
-- Background
-- ----------
-- The Recruitment module previously wrote every applicant into TWO independent
-- profile tables:
--
--   * recruit_candidates       -- the old "Candidate Database" profile store,
--                                 written on every application via
--                                 upsertCandidateProfile()
--   * recruitment_candidates   -- the canonical "Candidate Master" from the
--                                 unification layer
--
-- That is exactly the "same candidate copied into multiple independent records"
-- problem. The application code no longer writes or reads recruit_candidates:
--   - createApplication() now only calls linkApplicationToMaster()
--   - /api/recruit/candidates now reads listCandidateDatabase(), which is
--     backed by recruitment_candidates (Candidate Master)
--
-- This migration folds any people who exist ONLY in the legacy
-- recruit_candidates table into the Candidate Master so nobody is lost, then
-- retires the legacy table. It is idempotent and safe to re-run.
--
-- NOTE: run 2026-10-07-recruit-unification.sql FIRST — it creates the
-- recruitment_candidates columns (norm_email, norm_phone, application_id) this
-- migration relies on.
-- ===========================================================================

-- Guard: if the legacy table was never created on this database, there is
-- nothing to consolidate. The statements below are written so that a missing
-- recruit_candidates table simply makes them no-ops when wrapped by your
-- runner; if your runner stops on the first missing-table error, you can skip
-- this file entirely on that database.

-- ---------------------------------------------------------------------------
-- 1. Backfill Candidate Master from legacy profiles that have no match yet.
--    A legacy profile matches an existing Master row when they share a
--    normalized email OR normalized phone. Only truly-new people are inserted.
-- ---------------------------------------------------------------------------
INSERT INTO recruitment_candidates
  (candidate_id, candidate_name, email, mobile, norm_email, norm_phone,
   current_location, current_company, experience, application_date, created_at)
SELECT
  CONCAT('CANDLEG-', lc.id)                              AS candidate_id,
  COALESCE(NULLIF(lc.candidate_name, ''), 'Candidate')  AS candidate_name,
  lc.email,
  lc.phone,
  NULLIF(LOWER(TRIM(lc.email)), '')                     AS norm_email,
  CASE
    WHEN lc.phone IS NULL OR REGEXP_REPLACE(lc.phone, '[^0-9]', '') = '' THEN NULL
    WHEN CHAR_LENGTH(REGEXP_REPLACE(lc.phone, '[^0-9]', '')) > 10
      THEN RIGHT(REGEXP_REPLACE(lc.phone, '[^0-9]', ''), 10)
    ELSE REGEXP_REPLACE(lc.phone, '[^0-9]', '')
  END                                                   AS norm_phone,
  lc.location,
  lc.current_company,
  lc.experience,
  lc.last_applied,
  COALESCE(lc.created_at, NOW())
FROM recruit_candidates lc
WHERE NOT EXISTS (
  SELECT 1 FROM recruitment_candidates m
  WHERE (
      m.norm_email IS NOT NULL
      AND m.norm_email = NULLIF(LOWER(TRIM(lc.email)), '')
    )
    OR (
      m.norm_phone IS NOT NULL
      AND m.norm_phone = CASE
        WHEN lc.phone IS NULL OR REGEXP_REPLACE(lc.phone, '[^0-9]', '') = '' THEN NULL
        WHEN CHAR_LENGTH(REGEXP_REPLACE(lc.phone, '[^0-9]', '')) > 10
          THEN RIGHT(REGEXP_REPLACE(lc.phone, '[^0-9]', ''), 10)
        ELSE REGEXP_REPLACE(lc.phone, '[^0-9]', '')
      END
    )
)
-- Avoid double-inserting the same legacy person on a re-run.
AND NOT EXISTS (
  SELECT 1 FROM recruitment_candidates m2
  WHERE m2.candidate_id = CONCAT('CANDLEG-', lc.id)
);

-- ---------------------------------------------------------------------------
-- 2. Enrich existing Master rows with any non-empty fields that only the
--    legacy profile had (never overwrite an existing Master value).
-- ---------------------------------------------------------------------------
UPDATE recruitment_candidates m
JOIN recruit_candidates lc
  ON (
       m.norm_email IS NOT NULL
       AND m.norm_email = NULLIF(LOWER(TRIM(lc.email)), '')
     )
  OR (
       m.norm_phone IS NOT NULL
       AND m.norm_phone = CASE
         WHEN lc.phone IS NULL OR REGEXP_REPLACE(lc.phone, '[^0-9]', '') = '' THEN NULL
         WHEN CHAR_LENGTH(REGEXP_REPLACE(lc.phone, '[^0-9]', '')) > 10
           THEN RIGHT(REGEXP_REPLACE(lc.phone, '[^0-9]', ''), 10)
         ELSE REGEXP_REPLACE(lc.phone, '[^0-9]', '')
       END
     )
SET
  m.current_location = COALESCE(NULLIF(m.current_location, ''), NULLIF(lc.location, '')),
  m.current_company  = COALESCE(NULLIF(m.current_company, ''),  NULLIF(lc.current_company, '')),
  m.experience       = COALESCE(NULLIF(m.experience, ''),       NULLIF(lc.experience, '')),
  m.mobile           = COALESCE(NULLIF(m.mobile, ''),           NULLIF(lc.phone, '')),
  m.email            = COALESCE(NULLIF(m.email, ''),            NULLIF(lc.email, ''));

-- ---------------------------------------------------------------------------
-- 3. Retire the legacy table. Kept as a rename (not DROP) so the data is
--    recoverable; drop the archived copy once you've verified the Candidate
--    Database page looks correct.
-- ---------------------------------------------------------------------------
RENAME TABLE recruit_candidates TO recruit_candidates_legacy_20261008;
-- After verification you may run:
--   DROP TABLE IF EXISTS recruit_candidates_legacy_20261008;
