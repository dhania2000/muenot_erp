import { query } from "@/lib/db"

/**
 * Central, configurable finance masters for the Sales Invoice module.
 *
 * Three reusable masters back the invoice line editor so tax rates, HSN/SAC
 * codes and product/service definitions are configured in ONE place instead of
 * being hard-coded across the UI (–50):
 *
 *   - finance_tax_rates   : configurable GST rate slabs + tax categories.
 *   - finance_hsn_sac     : reusable HSN (goods) / SAC (services) catalogue.
 *   - finance_products    : product / service master (Muenot is service-first).
 *
 * The schema is self-creating and idempotent (same pattern as the rest of the
 * finance module) so it works on existing databases with no migration runner,
 * and seeds a sensible statutory starter set only when a table is empty.
 */

export const TAX_CATEGORIES = ["Taxable", "Zero Rated", "Exempt", "Nil Rated", "Non-GST"] as const
export type TaxCategory = (typeof TAX_CATEGORIES)[number]

export const HSN_KINDS = ["HSN", "SAC"] as const
export const PRODUCT_KINDS = ["Product", "Service"] as const

let ensured = false

export async function ensureFinanceMasters() {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS finance_tax_rates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL,
      name VARCHAR(120) NOT NULL,
      category VARCHAR(20) NOT NULL DEFAULT 'Taxable',
      rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      cess_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tax_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS finance_hsn_sac (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      kind VARCHAR(4) NOT NULL DEFAULT 'SAC',
      description VARCHAR(240) NOT NULL,
      default_tax_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      category VARCHAR(20) NOT NULL DEFAULT 'Taxable',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hsn_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS finance_products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL,
      name VARCHAR(190) NOT NULL,
      kind VARCHAR(10) NOT NULL DEFAULT 'Service',
      description TEXT,
      unit VARCHAR(20) DEFAULT 'Nos',
      rate DECIMAL(14,2) NOT NULL DEFAULT 0,
      hsn_sac VARCHAR(20) DEFAULT NULL,
      tax_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      tax_category VARCHAR(20) NOT NULL DEFAULT 'Taxable',
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_product_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await seedIfEmpty()
  ensured = true
}

async function isEmpty(table: string): Promise<boolean> {
  const rows = (await query(`SELECT COUNT(*) AS c FROM ${table}`)) as any[]
  return Number(rows?.[0]?.c ?? 0) === 0
}

async function seedIfEmpty() {
  if (await isEmpty("finance_tax_rates")) {
    const slabs: Array<[string, string, TaxCategory, number, number]> = [
      ["GST0", "GST 0%", "Taxable", 0, 0],
      ["GST5", "GST 5%", "Taxable", 5, 0],
      ["GST12", "GST 12%", "Taxable", 12, 0],
      ["GST18", "GST 18%", "Taxable", 18, 1],
      ["GST28", "GST 28%", "Taxable", 28, 0],
      ["ZERO", "Zero Rated (Export/SEZ)", "Zero Rated", 0, 0],
      ["EXEMPT", "Exempt", "Exempt", 0, 0],
      ["NIL", "Nil Rated", "Nil Rated", 0, 0],
      ["NONGST", "Non-GST", "Non-GST", 0, 0],
    ]
    for (const [code, name, category, rate, isDefault] of slabs) {
      await query(
        `INSERT INTO finance_tax_rates (code, name, category, rate, is_default) VALUES (?,?,?,?,?)`,
        [code, name, category, rate, isDefault],
      )
    }
  }

  if (await isEmpty("finance_hsn_sac")) {
    // Common SAC codes for a services business + a couple of goods HSNs.
    const codes: Array<[string, string, string, number]> = [
      ["998311", "SAC", "Management consulting & management services", 18],
      ["998313", "SAC", "Information technology consulting & support", 18],
      ["998314", "SAC", "IT design & development services", 18],
      ["998315", "SAC", "Hosting & IT infrastructure provisioning", 18],
      ["998316", "SAC", "IT infrastructure & network management", 18],
      ["998319", "SAC", "Other information technology services", 18],
      ["999293", "SAC", "Commercial training & coaching services", 18],
      ["998361", "SAC", "Advertising & content services", 18],
      ["997331", "SAC", "Licensing services for software", 18],
      ["8523", "HSN", "Software / recorded media", 18],
    ]
    for (const [code, kind, description, rate] of codes) {
      await query(
        `INSERT INTO finance_hsn_sac (code, kind, description, default_tax_rate) VALUES (?,?,?,?)`,
        [code, kind, description, rate],
      )
    }
  }

  if (await isEmpty("finance_products")) {
    // Representative service catalogue (service-oriented business).
    const items: Array<[string, string, string, number, string]> = [
      ["SVC-CONSULT", "Consulting Services", "Hours", 0, "998311"],
      ["SVC-DEV", "Software Development", "Hours", 0, "998314"],
      ["SVC-TRAIN", "Training & Enablement", "Days", 0, "999293"],
      ["SVC-CONTENT", "Content Services", "Project", 0, "998361"],
      ["SVC-AI", "AI Services", "Project", 0, "998319"],
      ["SVC-MANAGED", "Managed Services", "Months", 0, "998316"],
      ["SVC-SUB", "Subscription", "Subscription", 0, "997331"],
    ]
    for (const [code, name, unit, rate, hsn] of items) {
      await query(
        `INSERT INTO finance_products (code, name, kind, unit, rate, hsn_sac, tax_rate)
         VALUES (?,?,'Service',?,?,?,18)`,
        [code, name, unit, rate, hsn],
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listTaxRates(activeOnly = true) {
  await ensureFinanceMasters()
  return (await query(
    `SELECT * FROM finance_tax_rates ${activeOnly ? "WHERE is_active = 1" : ""} ORDER BY rate ASC, code ASC`,
  )) as any[]
}

export async function listHsnSac(search = "", activeOnly = true) {
  await ensureFinanceMasters()
  const where: string[] = []
  const args: any[] = []
  if (activeOnly) where.push("is_active = 1")
  if (search) {
    where.push("(code LIKE ? OR description LIKE ?)")
    args.push(`%${search}%`, `%${search}%`)
  }
  return (await query(
    `SELECT * FROM finance_hsn_sac ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY code ASC LIMIT 100`,
    args,
  )) as any[]
}

export async function listProducts(search = "", activeOnly = true) {
  await ensureFinanceMasters()
  const where: string[] = []
  const args: any[] = []
  if (activeOnly) where.push("is_active = 1")
  if (search) {
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)")
    args.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  return (await query(
    `SELECT * FROM finance_products ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY name ASC LIMIT 100`,
    args,
  )) as any[]
}

/**
 * Resolve the GST rate for an expense / bill line from the centralized tax
 * configuration (Phase 2 — rates are never hard-coded into the engine). The
 * HSN/SAC catalogue is authoritative for a code; otherwise the default taxable
 * slab is used. Returns the rate, cess and a version stamp so the posting can
 * freeze exactly which configuration applied (Phase 39).
 */
export async function resolveGstRate(opts: {
  hsnSac?: string | null
  date?: string | null
}): Promise<{ rate: number; cess: number; source: string; version: string } | null> {
  await ensureFinanceMasters()
  const code = String(opts.hsnSac ?? "").trim()
  const day = opts.date ? String(opts.date).slice(0, 10) : new Date().toISOString().slice(0, 10)

  if (code) {
    const rows = (await query(
      `SELECT default_tax_rate, category FROM finance_hsn_sac WHERE code = ? AND is_active = 1 LIMIT 1`,
      [code],
    )) as any[]
    if (rows[0]) {
      return {
        rate: Number(rows[0].default_tax_rate) || 0,
        cess: 0,
        source: `HSN/SAC ${code}`,
        version: `HSN:${code}@${day}`,
      }
    }
  }

  const def = (await query(
    `SELECT code, rate, cess_rate FROM finance_tax_rates
       WHERE is_active = 1 AND is_default = 1 ORDER BY updated_at DESC LIMIT 1`,
  )) as any[]
  if (def[0]) {
    return {
      rate: Number(def[0].rate) || 0,
      cess: Number(def[0].cess_rate) || 0,
      source: `Tax slab ${def[0].code}`,
      version: `TAX:${def[0].code}@${day}`,
    }
  }
  return null
}

const MASTER_TABLE: Record<string, string> = {
  tax: "finance_tax_rates",
  hsn: "finance_hsn_sac",
  product: "finance_products",
}

const MASTER_FIELDS: Record<string, string[]> = {
  tax: ["code", "name", "category", "rate", "cess_rate", "is_default", "is_active"],
  hsn: ["code", "kind", "description", "default_tax_rate", "category", "is_active"],
  product: ["code", "name", "kind", "description", "unit", "rate", "hsn_sac", "tax_rate", "tax_category", "currency", "is_active"],
}

export function masterTable(type: string) {
  return MASTER_TABLE[type] ?? null
}

export async function createMaster(type: string, body: Record<string, any>) {
  await ensureFinanceMasters()
  const table = MASTER_TABLE[type]
  const fields = MASTER_FIELDS[type]
  if (!table || !fields) throw new Error("Unknown master type")
  const record: Record<string, any> = {}
  for (const f of fields) if (body[f] !== undefined) record[f] = body[f]
  if (!record.code) throw new Error("Code is required")
  const cols = Object.keys(record)
  const result = (await query(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    cols.map((c) => record[c]),
  )) as any
  return Number(result?.insertId)
}

export async function updateMaster(type: string, id: number, body: Record<string, any>) {
  await ensureFinanceMasters()
  const table = MASTER_TABLE[type]
  const fields = MASTER_FIELDS[type]
  if (!table || !fields) throw new Error("Unknown master type")
  const update: Record<string, any> = {}
  for (const f of fields) if (body[f] !== undefined) update[f] = body[f]
  const cols = Object.keys(update)
  if (cols.length === 0) return
  await query(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`, [...cols.map((c) => update[c]), id])
}

export async function deleteMaster(type: string, id: number) {
  await ensureFinanceMasters()
  const table = MASTER_TABLE[type]
  if (!table) throw new Error("Unknown master type")
  // Soft-deactivate rather than hard delete so historical invoice lines that
  // referenced a master value keep their meaning.
  await query(`UPDATE ${table} SET is_active = 0 WHERE id = ?`, [id])
}
