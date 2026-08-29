// Creates all ERP tables and seeds a default admin user.
// Run with: node scripts/setup-db.mjs
import mysql from "mysql2/promise"
import bcrypt from "bcryptjs"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  email VARCHAR(191) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','employee') NOT NULL DEFAULT 'employee',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_access (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  module_key VARCHAR(64) NOT NULL,
  feature_key VARCHAR(64) NOT NULL,
  can_view TINYINT(1) NOT NULL DEFAULT 0,
  can_edit TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_user_feature (user_id, module_key, feature_key),
  CONSTRAINT fk_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_code VARCHAR(64),
  entry_date DATE NULL,
  name VARCHAR(255) NOT NULL,
  industry VARCHAR(128),
  website VARCHAR(255),
  linkedin_url VARCHAR(255),
  company_email VARCHAR(191),
  country VARCHAR(191),
  assigned_to VARCHAR(191),
  company_type VARCHAR(64),
  status VARCHAR(64),
  priority VARCHAR(64),
  created_by VARCHAR(191),
  last_contact_date DATE NULL,
  founded_year VARCHAR(16),
  num_employees INT NULL,
  KEY idx_company_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_code VARCHAR(64),
  entry_date DATE NULL,
  contact_person VARCHAR(191),
  contact_number VARCHAR(64),
  email VARCHAR(191),
  designation VARCHAR(191),
  source_url VARCHAR(512),
  lead_source VARCHAR(128),
  company_name VARCHAR(255),
  industry VARCHAR(128),
  website VARCHAR(255),
  company_email VARCHAR(191),
  country VARCHAR(191),
  assigned_to VARCHAR(191),
  status VARCHAR(64),
  follow_up_date DATE NULL,
  remarks TEXT,
  action VARCHAR(255),
  last_contact_date DATE NULL,
  sla_gap_days INT NULL,
  next_auto_follow_up DATE NULL,
  health_score INT NULL,
  KEY idx_lead_status (status),
  KEY idx_lead_company (company_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS followups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_code VARCHAR(64),
  entry_date DATE NULL,
  contact_person VARCHAR(191),
  email VARCHAR(191),
  company_name VARCHAR(255),
  assigned_to VARCHAR(191),
  status VARCHAR(64),
  follow_up_date DATE NULL,
  next_auto_follow_up DATE NULL,
  health_score INT NULL,
  remarks TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS meetings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_code VARCHAR(64),
  entry_date DATE NULL,
  company_name VARCHAR(255),
  meeting_time VARCHAR(64),
  contact_person VARCHAR(191),
  joining_by VARCHAR(191),
  meeting_type VARCHAR(64),
  agenda TEXT,
  outcome TEXT,
  next_steps TEXT,
  added_by VARCHAR(191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quotations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quote_code VARCHAR(64),
  entry_date DATE NULL,
  company_name VARCHAR(255),
  contact_person VARCHAR(191),
  opportunity_name VARCHAR(255),
  total_amount DECIMAL(14,2) NULL,
  valid_until DATE NULL,
  status VARCHAR(64),
  sent_by VARCHAR(191),
  added_by VARCHAR(191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contract_code VARCHAR(64),
  contract_date DATE NULL,
  company_name VARCHAR(255),
  start_date DATE NULL,
  end_date DATE NULL,
  duration_days INT NULL,
  project_name VARCHAR(255),
  value DECIMAL(14,2) NULL,
  contract_type VARCHAR(64),
  status VARCHAR(64),
  added_by VARCHAR(191),
  signed_by_client VARCHAR(191),
  signed_by_company VARCHAR(191),
  notes TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS onboarding (
  id INT AUTO_INCREMENT PRIMARY KEY,
  onboarding_code VARCHAR(64),
  onboarding_date DATE NULL,
  company_name VARCHAR(255),
  contract_code VARCHAR(64),
  start_date DATE NULL,
  kickoff_date DATE NULL,
  current_stage VARCHAR(64),
  status VARCHAR(64),
  onboarding_by VARCHAR(191),
  added_by VARCHAR(191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_code VARCHAR(64),
  entry_date DATE NULL,
  contact_person VARCHAR(191),
  email VARCHAR(191),
  company_name VARCHAR(255),
  industry VARCHAR(128),
  assigned_to VARCHAR(191),
  outcome ENUM('won','lost') NOT NULL,
  follow_up_date DATE NULL,
  health_score INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS revenue_forecast (
  id INT AUTO_INCREMENT PRIMARY KEY,
  forecast_code VARCHAR(64),
  forecast_date DATE NULL,
  quarter VARCHAR(16),
  year INT NULL,
  expected_revenue DECIMAL(14,2) NULL,
  best_case DECIMAL(14,2) NULL,
  worst_case DECIMAL(14,2) NULL,
  pipeline_coverage VARCHAR(32),
  owner VARCHAR(191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS outreach (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contact_name VARCHAR(191),
  email VARCHAR(191),
  company_name VARCHAR(255),
  designation VARCHAR(191),
  owner VARCHAR(191),
  subject VARCHAR(512),
  personal_intro TEXT,
  company_intro TEXT,
  value_add TEXT,
  status VARCHAR(64),
  next_follow_up DATE NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_finder (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(191),
  verified_email VARCHAR(191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

const conn = await mysql.createConnection({ uri: url, multipleStatements: true })
console.log("Connected. Creating tables...")
await conn.query(DDL)
console.log("Tables created.")

// Seed a default admin if none exists.
const [admins] = await conn.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
if (admins.length === 0) {
  const hash = await bcrypt.hash("admin123", 10)
  await conn.query("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", [
    "Admin",
    "admin@muenot.co.in",
    hash,
  ])
  console.log("Seeded admin: admin@muenot.co.in / admin123")
} else {
  console.log("Admin already exists, skipping seed.")
}

await conn.end()
console.log("Setup complete.")
