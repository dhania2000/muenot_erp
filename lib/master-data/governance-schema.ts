import "server-only"
/**
 * SPEC 91 — Master Data Governance schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Adds the governance layer on top of the SPEC 90 canonical masters. Follows
 * the same migration-runner-free pattern as the rest of the codebase: every
 * statement is CREATE TABLE IF NOT EXISTS, safe to run on every request and
 * against a live production database.
 *
 * Three tenant-owned tables (registered in lib/tenant-tables.ts):
 *   - md_gov_records         : the governance state of each critical value —
 *                              status, owner, approval authority, effective
 *                              date, version.
 *   - md_gov_change_requests : the maker/checker workflow — a proposed change
 *                              awaiting approval, with its payload.
 *   - md_gov_history         : append-only change history / audit of every
 *                              status transition and decision.
 */
import { query } from "@/lib/db"
import { ensureMasterDataSchema } from "./schema"

let ensured: Promise<void> | null = null

export function ensureGovernanceSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  // Governance sits on top of the canonical masters, so make sure they exist.
  await ensureMasterDataSchema()

  await query(`
    CREATE TABLE IF NOT EXISTS md_gov_records (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      master_kind VARCHAR(40) NOT NULL,
      code VARCHAR(60) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      owner_id INT DEFAULT NULL,
      approval_authority VARCHAR(40) DEFAULT NULL,
      effective_date DATE DEFAULT NULL,
      version INT NOT NULL DEFAULT 1,
      updated_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gov_rec (tenant_id, master_kind, code),
      KEY idx_gov_rec_tenant (tenant_id),
      KEY idx_gov_rec_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_gov_change_requests (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      master_kind VARCHAR(40) NOT NULL,
      code VARCHAR(60) NOT NULL,
      action VARCHAR(20) NOT NULL,
      payload JSON DEFAULT NULL,
      effective_date DATE DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      requested_by INT DEFAULT NULL,
      request_comment TEXT DEFAULT NULL,
      reviewed_by INT DEFAULT NULL,
      review_comment TEXT DEFAULT NULL,
      reviewed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_gov_cr_tenant (tenant_id),
      KEY idx_gov_cr_status (tenant_id, status),
      KEY idx_gov_cr_target (tenant_id, master_kind, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_gov_history (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      master_kind VARCHAR(40) NOT NULL,
      code VARCHAR(60) NOT NULL,
      event VARCHAR(30) NOT NULL,
      from_status VARCHAR(20) DEFAULT NULL,
      to_status VARCHAR(20) DEFAULT NULL,
      actor_id INT DEFAULT NULL,
      change_request_id BIGINT DEFAULT NULL,
      detail JSON DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_gov_hist_target (tenant_id, master_kind, code),
      KEY idx_gov_hist_cr (change_request_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
