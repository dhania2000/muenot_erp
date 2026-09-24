import "server-only"
/**
 * SPEC 95 — Custom Forms schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Same migration-runner-free pattern as the rest of the codebase: every
 * statement is CREATE TABLE IF NOT EXISTS, safe to run on every request and
 * against a live production database.
 *
 * Two tenant-owned tables (registered in lib/tenant-tables.ts):
 *   - custom_forms             : one row per form DEFINITION — its title, slug,
 *                                status, approval config and the sections /
 *                                fields / conditional rules as JSON. UNIQUE
 *                                (tenant, slug).
 *   - custom_form_submissions  : one row per submission — the captured values
 *                                plus the workflow state (draft / submitted /
 *                                pending / approved / rejected) and the review
 *                                trail. Indexed by (tenant, form) and by
 *                                (tenant, status) for the approval queue.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureCustomFormSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
