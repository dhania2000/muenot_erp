-- =============================================================================
-- SPEC 95 — Custom Forms
-- -----------------------------------------------------------------------------
-- Lets authorized admins build custom forms with sections, fields, conditional
-- fields, required fields, help text, attachments, approval and a submission
-- workflow. custom_forms holds each form DEFINITION (as JSON sections);
-- custom_form_submissions holds each submission plus its workflow state and
-- review trail.
--
-- The application self-heals these tables at runtime
-- (lib/custom-forms/schema.ts #ensureCustomFormSchema); this migration is the
-- canonical, idempotent record of that schema.
-- =============================================================================

-- Form definitions. UNIQUE (tenant, slug).
CREATE TABLE IF NOT EXISTS custom_forms (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  slug VARCHAR(160) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  submit_label VARCHAR(80) NOT NULL DEFAULT 'Submit',
  approval_enabled TINYINT NOT NULL DEFAULT 0,
  approver_min_role VARCHAR(20) NOT NULL DEFAULT 'tenant_admin',
  sections_json JSON NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_custom_form_slug (tenant_id, slug),
  KEY idx_custom_form_tenant (tenant_id),
  KEY idx_custom_form_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Submissions. Indexed by (tenant, form) and by (tenant, status) for the
-- approval queue.
CREATE TABLE IF NOT EXISTS custom_form_submissions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  form_id BIGINT NOT NULL,
  form_version INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  values_json JSON NOT NULL,
  submitted_by INT DEFAULT NULL,
  submitted_at TIMESTAMP NULL DEFAULT NULL,
  reviewed_by INT DEFAULT NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  review_note VARCHAR(1000) NOT NULL DEFAULT '',
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_custom_form_sub_form (tenant_id, form_id),
  KEY idx_custom_form_sub_status (tenant_id, status),
  KEY idx_custom_form_sub_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
