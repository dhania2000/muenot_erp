import "server-only"
/**
 * SPEC 90 — Centralized Master Data schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Creates the canonical master tables and seeds sensible defaults. Follows the
 * same runtime, migration-runner-free pattern as the rest of the codebase
 * (finance-masters, dms/schema): every statement is CREATE TABLE IF NOT EXISTS
 * / seed-if-empty, so it is safe to call on every request and against a live
 * production database.
 *
 * Backing model (see registry.ts):
 *   - Global catalogue tables (no tenant_id): md_countries, md_states,
 *     md_cities, md_currencies, md_units, md_payment_terms, md_approval_levels.
 *   - Tenant-owned tables (tenant_id, registered in lib/tenant-tables.ts):
 *     md_cost_centers, md_locations, md_categories.
 *   - A shared audit trail: md_master_audit.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

/** Idempotently create + seed all canonical master tables. */
export function ensureMasterDataSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function isEmpty(table: string): Promise<boolean> {
  const rows = (await query<any[]>(`SELECT COUNT(*) AS c FROM ${table}`)) as any[]
  return Number(rows?.[0]?.c ?? 0) === 0
}

async function doEnsure(): Promise<void> {
  // -------------------------------------------------------------------------
  // Global reference catalogue (shared by every tenant)
  // -------------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS md_currencies (
      code VARCHAR(3) NOT NULL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      symbol VARCHAR(8) DEFAULT NULL,
      decimals TINYINT NOT NULL DEFAULT 2,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_countries (
      code VARCHAR(2) NOT NULL PRIMARY KEY,
      iso3 VARCHAR(3) DEFAULT NULL,
      name VARCHAR(120) NOT NULL,
      dial_code VARCHAR(8) DEFAULT NULL,
      currency_code VARCHAR(3) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_md_countries_currency (currency_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_states (
      code VARCHAR(12) NOT NULL PRIMARY KEY,
      country_code VARCHAR(2) NOT NULL,
      name VARCHAR(120) NOT NULL,
      gst_state_code VARCHAR(4) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_md_states_country (country_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_cities (
      code VARCHAR(20) NOT NULL PRIMARY KEY,
      state_code VARCHAR(12) DEFAULT NULL,
      country_code VARCHAR(2) NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_md_cities_state (state_code),
      KEY idx_md_cities_country (country_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_units (
      code VARCHAR(20) NOT NULL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      dimension VARCHAR(20) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_payment_terms (
      code VARCHAR(20) NOT NULL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      net_days INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_approval_levels (
      code VARCHAR(20) NOT NULL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      level_no INT NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // -------------------------------------------------------------------------
  // Tenant-owned business masters (guarded by lib/tenant-guard.ts)
  // -------------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS md_cost_centers (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      code VARCHAR(40) NOT NULL,
      name VARCHAR(160) NOT NULL,
      parent_code VARCHAR(40) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_md_cc_tenant_code (tenant_id, code),
      KEY idx_md_cc_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_locations (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      code VARCHAR(40) NOT NULL,
      name VARCHAR(160) NOT NULL,
      city_code VARCHAR(20) DEFAULT NULL,
      state_code VARCHAR(12) DEFAULT NULL,
      country_code VARCHAR(2) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_md_loc_tenant_code (tenant_id, code),
      KEY idx_md_loc_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS md_categories (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      domain VARCHAR(40) NOT NULL DEFAULT 'general',
      code VARCHAR(60) NOT NULL,
      name VARCHAR(160) NOT NULL,
      color VARCHAR(20) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_md_cat_tenant_domain_code (tenant_id, domain, code),
      KEY idx_md_cat_tenant (tenant_id),
      KEY idx_md_cat_domain (tenant_id, domain)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // -------------------------------------------------------------------------
  // Shared audit trail for every canonical master change
  // -------------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS md_master_audit (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT DEFAULT NULL,
      master_kind VARCHAR(40) NOT NULL,
      code VARCHAR(60) NOT NULL,
      action VARCHAR(20) NOT NULL,
      user_id INT DEFAULT NULL,
      old_value JSON DEFAULT NULL,
      new_value JSON DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mda_kind (master_kind),
      KEY idx_mda_code (master_kind, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await seedGlobals()
}

async function seedGlobals(): Promise<void> {
  if (await isEmpty("md_currencies")) {
    const rows: Array<[string, string, string, number]> = [
      ["INR", "Indian Rupee", "\u20B9", 2],
      ["USD", "US Dollar", "$", 2],
      ["EUR", "Euro", "\u20AC", 2],
      ["GBP", "Pound Sterling", "\u00A3", 2],
      ["AED", "UAE Dirham", "\u062F.\u0625", 2],
      ["SGD", "Singapore Dollar", "S$", 2],
      ["AUD", "Australian Dollar", "A$", 2],
      ["CAD", "Canadian Dollar", "C$", 2],
      ["JPY", "Japanese Yen", "\u00A5", 0],
      ["CNY", "Chinese Yuan", "\u00A5", 2],
      ["CHF", "Swiss Franc", "CHF", 2],
      ["HKD", "Hong Kong Dollar", "HK$", 2],
      ["SAR", "Saudi Riyal", "\uFDFC", 2],
      ["MYR", "Malaysian Ringgit", "RM", 2],
      ["ZAR", "South African Rand", "R", 2],
    ]
    for (const [code, name, symbol, decimals] of rows) {
      await query(`INSERT INTO md_currencies (code, name, symbol, decimals) VALUES (?,?,?,?)`, [code, name, symbol, decimals])
    }
  }

  if (await isEmpty("md_countries")) {
    const rows: Array<[string, string, string, string, string]> = [
      ["IN", "IND", "India", "+91", "INR"],
      ["US", "USA", "United States", "+1", "USD"],
      ["GB", "GBR", "United Kingdom", "+44", "GBP"],
      ["AE", "ARE", "United Arab Emirates", "+971", "AED"],
      ["SG", "SGP", "Singapore", "+65", "SGD"],
      ["AU", "AUS", "Australia", "+61", "AUD"],
      ["CA", "CAN", "Canada", "+1", "CAD"],
      ["DE", "DEU", "Germany", "+49", "EUR"],
      ["FR", "FRA", "France", "+33", "EUR"],
      ["JP", "JPN", "Japan", "+81", "JPY"],
      ["CN", "CHN", "China", "+86", "CNY"],
      ["CH", "CHE", "Switzerland", "+41", "CHF"],
      ["HK", "HKG", "Hong Kong", "+852", "HKD"],
      ["SA", "SAU", "Saudi Arabia", "+966", "SAR"],
      ["MY", "MYS", "Malaysia", "+60", "MYR"],
      ["ZA", "ZAF", "South Africa", "+27", "ZAR"],
    ]
    for (const [code, iso3, name, dial, currency] of rows) {
      await query(`INSERT INTO md_countries (code, iso3, name, dial_code, currency_code) VALUES (?,?,?,?,?)`, [
        code,
        iso3,
        name,
        dial,
        currency,
      ])
    }
  }

  if (await isEmpty("md_states")) {
    // Indian states + UTs with statutory GST state codes (GST context is INR-first).
    const rows: Array<[string, string, string]> = [
      ["IN-AP", "Andhra Pradesh", "37"],
      ["IN-AR", "Arunachal Pradesh", "12"],
      ["IN-AS", "Assam", "18"],
      ["IN-BR", "Bihar", "10"],
      ["IN-CG", "Chhattisgarh", "22"],
      ["IN-GA", "Goa", "30"],
      ["IN-GJ", "Gujarat", "24"],
      ["IN-HR", "Haryana", "06"],
      ["IN-HP", "Himachal Pradesh", "02"],
      ["IN-JH", "Jharkhand", "20"],
      ["IN-KA", "Karnataka", "29"],
      ["IN-KL", "Kerala", "32"],
      ["IN-MP", "Madhya Pradesh", "23"],
      ["IN-MH", "Maharashtra", "27"],
      ["IN-MN", "Manipur", "14"],
      ["IN-ML", "Meghalaya", "17"],
      ["IN-MZ", "Mizoram", "15"],
      ["IN-NL", "Nagaland", "13"],
      ["IN-OR", "Odisha", "21"],
      ["IN-PB", "Punjab", "03"],
      ["IN-RJ", "Rajasthan", "08"],
      ["IN-SK", "Sikkim", "11"],
      ["IN-TN", "Tamil Nadu", "33"],
      ["IN-TG", "Telangana", "36"],
      ["IN-TR", "Tripura", "16"],
      ["IN-UP", "Uttar Pradesh", "09"],
      ["IN-UK", "Uttarakhand", "05"],
      ["IN-WB", "West Bengal", "19"],
      ["IN-DL", "Delhi", "07"],
      ["IN-JK", "Jammu and Kashmir", "01"],
      ["IN-LA", "Ladakh", "38"],
      ["IN-CH", "Chandigarh", "04"],
      ["IN-PY", "Puducherry", "34"],
      ["IN-AN", "Andaman and Nicobar Islands", "35"],
      ["IN-DH", "Dadra and Nagar Haveli and Daman and Diu", "26"],
      ["IN-LD", "Lakshadweep", "31"],
    ]
    for (const [code, name, gst] of rows) {
      await query(`INSERT INTO md_states (code, country_code, name, gst_state_code) VALUES (?, 'IN', ?, ?)`, [code, name, gst])
    }
  }

  if (await isEmpty("md_cities")) {
    // Seed the major metros; the master is extensible per deployment.
    const rows: Array<[string, string, string]> = [
      ["IN-MH-MUM", "IN-MH", "Mumbai"],
      ["IN-MH-PUN", "IN-MH", "Pune"],
      ["IN-DL-DEL", "IN-DL", "New Delhi"],
      ["IN-KA-BLR", "IN-KA", "Bengaluru"],
      ["IN-TG-HYD", "IN-TG", "Hyderabad"],
      ["IN-TN-MAA", "IN-TN", "Chennai"],
      ["IN-WB-CCU", "IN-WB", "Kolkata"],
      ["IN-GJ-AMD", "IN-GJ", "Ahmedabad"],
      ["IN-RJ-JAI", "IN-RJ", "Jaipur"],
      ["IN-UP-NOI", "IN-UP", "Noida"],
      ["IN-HR-GGN", "IN-HR", "Gurugram"],
    ]
    for (const [code, state, name] of rows) {
      await query(`INSERT INTO md_cities (code, state_code, country_code, name) VALUES (?, ?, 'IN', ?)`, [code, state, name])
    }
  }

  if (await isEmpty("md_units")) {
    const rows: Array<[string, string, string]> = [
      ["NOS", "Numbers", "count"],
      ["HRS", "Hours", "time"],
      ["DAY", "Days", "time"],
      ["MON", "Months", "time"],
      ["YRS", "Years", "time"],
      ["PRJ", "Project", "count"],
      ["SUB", "Subscription", "count"],
      ["SET", "Set", "count"],
      ["BOX", "Box", "count"],
      ["KG", "Kilogram", "weight"],
      ["GM", "Gram", "weight"],
      ["LTR", "Litre", "volume"],
      ["MTR", "Metre", "length"],
      ["SQM", "Square Metre", "area"],
      ["PCS", "Pieces", "count"],
    ]
    for (const [code, name, dim] of rows) {
      await query(`INSERT INTO md_units (code, name, dimension) VALUES (?,?,?)`, [code, name, dim])
    }
  }

  if (await isEmpty("md_payment_terms")) {
    const rows: Array<[string, string, number]> = [
      ["DUE_RECEIPT", "Due on Receipt", 0],
      ["NET7", "Net 7 Days", 7],
      ["NET15", "Net 15 Days", 15],
      ["NET30", "Net 30 Days", 30],
      ["NET45", "Net 45 Days", 45],
      ["NET60", "Net 60 Days", 60],
      ["NET90", "Net 90 Days", 90],
      ["ADVANCE", "Advance Payment", 0],
    ]
    for (const [code, name, days] of rows) {
      await query(`INSERT INTO md_payment_terms (code, name, net_days) VALUES (?,?,?)`, [code, name, days])
    }
  }

  if (await isEmpty("md_approval_levels")) {
    const rows: Array<[string, string, number]> = [
      ["L1", "Level 1 — Maker", 1],
      ["L2", "Level 2 — Checker", 2],
      ["L3", "Level 3 — Manager", 3],
      ["L4", "Level 4 — Head", 4],
      ["L5", "Level 5 — Director", 5],
    ]
    for (const [code, name, no] of rows) {
      await query(`INSERT INTO md_approval_levels (code, name, level_no) VALUES (?,?,?)`, [code, name, no])
    }
  }
}
