import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// HR Letters — server-only schema self-heal + company settings.
//
// The original migration created minimal `hr_letter_templates` / `hr_letters`
// tables (name/subject/body + Active|Inactive / Draft|Issued). This module
// idempotently upgrades them to the enhanced model (categories, audiences,
// event sourcing, template versioning, generation lineage) so the feature
// works before any SQL migration is applied by hand. Every ALTER is guarded so
// one existing column never aborts the rest — mirroring ensureEmployeeDocuments
// Schema / ensureOffboardingSchema across the HR module. Additive only.
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

export function ensureLetterTables(): Promise<void> {
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
  // --- Base tables (create if the migration never ran) ---------------------
  await query(
    `CREATE TABLE IF NOT EXISTS hr_letter_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      letter_type VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_letter_template_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS hr_letters (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      letter_number VARCHAR(40) NOT NULL,
      employee_id INT UNSIGNED NULL,
      template_id BIGINT UNSIGNED NULL,
      letter_type VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      issue_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Draft',
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_letter_number (letter_number),
      KEY idx_hr_letters_employee (employee_id),
      KEY idx_hr_letters_template (template_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // --- Relax legacy ENUM status columns to VARCHAR so the richer lifecycle
  //     values (Draft/Active/Inactive/Archived and Draft/Generated/Issued/
  //     Delivered/Cancelled) are accepted. -----------------------------------
  for (const sql of [
    "ALTER TABLE hr_letter_templates MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'Active'",
    "ALTER TABLE hr_letters MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'Draft'",
    // Recruitment (candidate) letters have no employee row — allow NULL.
    "ALTER TABLE hr_letters MODIFY COLUMN employee_id INT UNSIGNED NULL",
  ]) {
    try {
      await query(sql)
    } catch {
      // Already the target type, or a no-op the server rejects.
    }
  }

  // --- Enhanced template columns ------------------------------------------
  await addColumns("hr_letter_templates", [
    "`template_uid` VARCHAR(40) NULL",
    "`template_key` VARCHAR(80) NULL",
    "`description` VARCHAR(500) NULL",
    "`category` VARCHAR(40) NOT NULL DEFAULT 'General'",
    "`audience` VARCHAR(30) NOT NULL DEFAULT 'Employee'",
    "`event_key` VARCHAR(60) NOT NULL DEFAULT 'manual'",
    "`version` INT UNSIGNED NOT NULL DEFAULT 1",
    "`usage_count` INT UNSIGNED NOT NULL DEFAULT 0",
    "`last_used_at` DATETIME NULL",
    "`required_variables` JSON NULL",
    "`updated_by` BIGINT UNSIGNED NULL",
  ])
  await addIndexes("hr_letter_templates", [
    "UNIQUE KEY uq_hr_letter_template_uid (template_uid)",
    "UNIQUE KEY uq_hr_letter_template_key (template_key)",
    "KEY idx_hr_letter_template_status (status)",
    "KEY idx_hr_letter_template_category (category)",
    "KEY idx_hr_letter_template_event (event_key)",
  ])

  // --- Enhanced generated-letter columns ----------------------------------
  await addColumns("hr_letters", [
    "`template_version` INT UNSIGNED NULL",
    "`category` VARCHAR(40) NULL",
    "`audience` VARCHAR(30) NULL",
    "`source` VARCHAR(30) NOT NULL DEFAULT 'manual'",
    "`source_ref` VARCHAR(80) NULL",
    "`event_key` VARCHAR(60) NOT NULL DEFAULT 'manual'",
    "`recipient_name` VARCHAR(190) NULL",
    "`document_id` INT UNSIGNED NULL",
    "`email_id` BIGINT UNSIGNED NULL",
    "`supersedes_id` BIGINT UNSIGNED NULL",
    "`superseded_by` BIGINT UNSIGNED NULL",
    "`dedupe_key` VARCHAR(190) NULL",
    "`variables_snapshot` JSON NULL",
    "`issued_at` DATETIME NULL",
    "`delivered_at` DATETIME NULL",
  ])
  await addIndexes("hr_letters", [
    "KEY idx_hr_letters_status (status)",
    "KEY idx_hr_letters_source (source, source_ref)",
    "KEY idx_hr_letters_template_ver (template_id, template_version)",
    "UNIQUE KEY uq_hr_letters_dedupe (dedupe_key)",
  ])

  // --- Template version history -------------------------------------------
  await query(
    `CREATE TABLE IF NOT EXISTS hr_letter_template_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_id BIGINT UNSIGNED NOT NULL,
      version INT UNSIGNED NOT NULL,
      name VARCHAR(150) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'General',
      letter_type VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
      audience VARCHAR(30) NOT NULL DEFAULT 'Employee',
      event_key VARCHAR(60) NOT NULL DEFAULT 'manual',
      status VARCHAR(20) NOT NULL DEFAULT 'Draft',
      change_note VARCHAR(500) NULL,
      changed_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_hr_letter_tpl_ver (template_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // --- Backfill template_uid for legacy rows -------------------------------
  try {
    const legacy = await query<{ id: number }[]>(
      "SELECT id FROM hr_letter_templates WHERE template_uid IS NULL OR template_uid = '' ORDER BY id ASC",
    )
    for (const row of legacy) {
      await query("UPDATE hr_letter_templates SET template_uid = ? WHERE id = ?", [
        `LT-${String(row.id).padStart(4, "0")}`,
        row.id,
      ])
    }
  } catch {
    // Non-fatal — uids are also generated going forward via nextRecordId.
  }

  // --- Sidebar features (gated by permissions, like the rest of HR) --------
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'HR Letter Templates','hr.view_letter_templates','Create and manage letter templates',32 FROM modules WHERE slug='hr'`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'HR Letters','hr.view_letters','Issue letters to employees',33 FROM modules WHERE slug='hr'`,
  )
}

/** Read company settings as a flat key/value map for letter merging. */
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
