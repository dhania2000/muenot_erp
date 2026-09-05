import { query } from "@/lib/db"

// Self-creating table + feature seeds, mirroring the company-settings route's
// ensureTable() pattern so the Clients feature works without a migration runner.
let ensured = false

export async function ensureClientTables() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS clients (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      client_code VARCHAR(40) NOT NULL,
      salutation VARCHAR(10) NULL,
      client_name VARCHAR(150) NOT NULL,
      email VARCHAR(190) NOT NULL,
      login_allowed ENUM('Yes','No') NOT NULL DEFAULT 'No',
      email_notifications ENUM('Yes','No') NOT NULL DEFAULT 'Yes',
      gender VARCHAR(20) NULL,
      language VARCHAR(40) NULL,
      mobile VARCHAR(40) NULL,
      company_name VARCHAR(190) NULL,
      website VARCHAR(190) NULL,
      tax_name VARCHAR(80) NULL,
      gst_number VARCHAR(60) NULL,
      office_phone VARCHAR(40) NULL,
      address VARCHAR(255) NULL,
      city VARCHAR(120) NULL,
      state VARCHAR(120) NULL,
      country VARCHAR(120) NULL,
      postal_code VARCHAR(30) NULL,
      category VARCHAR(120) NULL,
      sub_category VARCHAR(120) NULL,
      currency VARCHAR(10) NULL,
      status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
      notes TEXT NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_client_code (client_code),
      KEY idx_clients_name (client_name)
    )`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Clients Dashboard','clients.view_dashboard','View the clients module dashboard',1 FROM modules WHERE slug='clients'`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Clients','clients.view_clients','View clients list',2 FROM modules WHERE slug='clients'`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Clients','clients.manage_clients','Add, edit and delete clients',3 FROM modules WHERE slug='clients'`,
  )
  ensured = true
}
