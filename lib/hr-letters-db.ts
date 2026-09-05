import { query } from "@/lib/db"

// Self-creating tables + feature seeds, mirroring the company-settings route's
// ensureTable() pattern so the Letter feature works without a migration runner.
let ensured = false

export async function ensureLetterTables() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS hr_letter_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      letter_type VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_letter_template_name (name)
    )`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS hr_letters (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      letter_number VARCHAR(40) NOT NULL,
      employee_id INT UNSIGNED NOT NULL,
      template_id BIGINT UNSIGNED NULL,
      letter_type VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      issue_date DATE NOT NULL,
      status ENUM('Draft','Issued') NOT NULL DEFAULT 'Draft',
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_letter_number (letter_number),
      KEY idx_hr_letters_employee (employee_id),
      KEY idx_hr_letters_template (template_id)
    )`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'HR Letter Templates','hr.view_letter_templates','Create and manage letter templates',32 FROM modules WHERE slug='hr'`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'HR Letters','hr.view_letters','Issue letters to employees',33 FROM modules WHERE slug='hr'`,
  )
  ensured = true
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
