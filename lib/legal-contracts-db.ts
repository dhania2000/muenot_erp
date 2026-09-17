import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Legal Contracts — server-only schema self-heal + company profile reader.
//
// Idempotently creates the contract template master, template version history,
// variable master and generated-contract tables so the feature works before
// the SQL migration (database/migrations/2026-09-17-add-legal-contracts.sql)
// is applied by hand on Hostinger. Every ALTER is guarded so one existing
// column never aborts the rest — mirroring ensureLetterTables in the HR module.
// Additive only; never drops or narrows existing columns.
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

export function ensureContractTables(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function haveColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ COLUMN_NAME: string }[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  ).catch(() => [] as { COLUMN_NAME: string }[])
  return new Set(rows.map((r) => r.COLUMN_NAME))
}

async function addColumns(table: string, additions: string[]) {
  const have = await haveColumns(table)
  for (const clause of additions) {
    const col = clause.match(/`([^`]+)`/)?.[1]
    if (col && have.has(col)) continue
    try {
      await query(`ALTER TABLE ${table} ADD COLUMN ${clause}`)
    } catch {
      // Column already present on a server without IF NOT EXISTS support.
    }
  }
}

async function addIndexes(table: string, indexes: string[]) {
  for (const idx of indexes) {
    try {
      await query(`ALTER TABLE ${table} ADD ${idx}`)
    } catch {
      // Index already exists.
    }
  }
}

async function doEnsure() {
  // --- Contract template master -------------------------------------------
  await query(
    `CREATE TABLE IF NOT EXISTS legal_contract_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_uid VARCHAR(40) NULL,
      name VARCHAR(190) NOT NULL,
      contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
      category VARCHAR(40) NOT NULL DEFAULT 'Other',
      description VARCHAR(600) NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'manual',
      version INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'Draft',
      content LONGTEXT NOT NULL,
      required_variables JSON NULL,
      owner_id BIGINT UNSIGNED NULL,
      usage_count INT UNSIGNED NOT NULL DEFAULT 0,
      last_used_at DATETIME NULL,
      review_date DATE NULL,
      expiry_date DATE NULL,
      created_by BIGINT UNSIGNED NULL,
      updated_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_contract_template_uid (template_uid),
      KEY idx_contract_template_status (status),
      KEY idx_contract_template_type (contract_type),
      KEY idx_contract_template_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Guarded additive columns for installs that created a leaner table earlier.
  await addColumns("legal_contract_templates", [
    "`template_uid` VARCHAR(40) NULL",
    "`description` VARCHAR(600) NULL",
    "`source` VARCHAR(30) NOT NULL DEFAULT 'manual'",
    "`version` INT UNSIGNED NOT NULL DEFAULT 1",
    "`required_variables` JSON NULL",
    "`owner_id` BIGINT UNSIGNED NULL",
    "`usage_count` INT UNSIGNED NOT NULL DEFAULT 0",
    "`last_used_at` DATETIME NULL",
    "`review_date` DATE NULL",
    "`expiry_date` DATE NULL",
    "`updated_by` BIGINT UNSIGNED NULL",
  ])
  await addIndexes("legal_contract_templates", [
    "UNIQUE KEY uq_contract_template_uid (template_uid)",
    "KEY idx_contract_template_status (status)",
  ])

  // --- Template version history -------------------------------------------
  await query(
    `CREATE TABLE IF NOT EXISTS legal_contract_template_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_id BIGINT UNSIGNED NOT NULL,
      version INT UNSIGNED NOT NULL,
      name VARCHAR(190) NOT NULL,
      contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
      category VARCHAR(40) NOT NULL DEFAULT 'Other',
      source VARCHAR(30) NOT NULL DEFAULT 'manual',
      status VARCHAR(20) NOT NULL DEFAULT 'Draft',
      content LONGTEXT NOT NULL,
      change_note VARCHAR(500) NULL,
      changed_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_contract_tpl_ver (template_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // --- Variable master (configurable) -------------------------------------
  await query(
    `CREATE TABLE IF NOT EXISTS legal_contract_variables (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      var_key VARCHAR(80) NOT NULL,
      display_name VARCHAR(150) NOT NULL,
      data_source VARCHAR(40) NOT NULL DEFAULT 'manual',
      field VARCHAR(120) NULL,
      grp VARCHAR(60) NOT NULL DEFAULT 'General',
      required TINYINT(1) NOT NULL DEFAULT 0,
      description VARCHAR(400) NULL,
      example_value VARCHAR(190) NULL,
      is_builtin TINYINT(1) NOT NULL DEFAULT 0,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_contract_var_key (var_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // --- Generated contracts -------------------------------------------------
  await query(
    `CREATE TABLE IF NOT EXISTS legal_generated_contracts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contract_uid VARCHAR(40) NOT NULL,
      reference_no VARCHAR(60) NULL,
      title VARCHAR(220) NOT NULL,
      template_id BIGINT UNSIGNED NULL,
      template_version INT UNSIGNED NULL,
      contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
      category VARCHAR(40) NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'manual',
      source_ref VARCHAR(80) NULL,
      party_type VARCHAR(40) NULL,
      party_name VARCHAR(190) NULL,
      party_id VARCHAR(80) NULL,
      content LONGTEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Generated',
      version INT UNSIGNED NOT NULL DEFAULT 1,
      effective_date DATE NULL,
      start_date DATE NULL,
      end_date DATE NULL,
      renewal_date DATE NULL,
      document_id INT UNSIGNED NULL,
      variables_snapshot JSON NULL,
      supersedes_id BIGINT UNSIGNED NULL,
      superseded_by BIGINT UNSIGNED NULL,
      dedupe_key VARCHAR(190) NULL,
      generated_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_generated_contract_uid (contract_uid),
      UNIQUE KEY uq_generated_contract_reference (reference_no),
      UNIQUE KEY uq_generated_contract_dedupe (dedupe_key),
      KEY idx_generated_contract_status (status),
      KEY idx_generated_contract_source (source, source_ref),
      KEY idx_generated_contract_template (template_id, template_version),
      KEY idx_generated_contract_expiry (end_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // --- Sidebar features (gated by RBAC, like the rest of Legal) ------------
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Contract Templates','legal.view_contract_templates','Create and manage contract templates',3 FROM modules WHERE slug='legal'`,
  ).catch(() => {})
}

/** Read company_settings as a flat key/value map for contract merging. */
export async function getCompanySettings(): Promise<Record<string, string>> {
  try {
    const rows = await query<any[]>("SELECT skey, svalue FROM company_settings")
    const values: Record<string, string> = {}
    for (const r of rows) values[r.skey] = r.svalue ?? ""
    return values
  } catch {
    return {}
  }
}
