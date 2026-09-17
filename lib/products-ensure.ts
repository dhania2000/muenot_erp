import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing schema for the Product & Inventory Master.
 *
 * The existing "Products → Product Catalog" was a UI-only placeholder with no
 * tables, so this provisions the real master + inventory tables on first use
 * (same CREATE TABLE IF NOT EXISTS / information_schema pattern the Finance and
 * Messages modules use). It also adds a nullable `product_id`/`product_pk` link
 * onto the EXISTING sales_invoice_items and purchase_bill_items tables so stock
 * can move from real transactions without duplicating those masters.
 *
 * Runs once per process.
 */
let ensured = false

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  )
  return rows.length > 0
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function ensureColumn(table: string, column: string, definition: string) {
  if (!(await tableExists(table))) return
  if (!(await columnExists(table, column))) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function ensureIndex(table: string, index: string, cols: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD KEY \`${index}\` (${cols})`).catch(() => {})
  }
}

const DEFAULT_CATEGORIES = [
  "Software",
  "Service",
  "Hardware",
  "Office Supplies",
  "Recruitment Services",
  "Training",
  "Digital Product",
  "Physical Product",
  "Subscription",
  "Other",
]

export async function ensureProductSchema() {
  if (ensured) return

  // ── Product master ─────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_id VARCHAR(30) NOT NULL,
      name VARCHAR(255) NOT NULL,
      sku VARCHAR(120) DEFAULT NULL,
      product_code VARCHAR(120) DEFAULT NULL,
      category VARCHAR(120) DEFAULT NULL,
      subcategory VARCHAR(120) DEFAULT NULL,
      brand VARCHAR(120) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      product_type VARCHAR(30) NOT NULL DEFAULT 'Goods',
      unit VARCHAR(30) NOT NULL DEFAULT 'Nos',
      hsn_sac VARCHAR(20) DEFAULT NULL,
      gst_applicable TINYINT(1) NOT NULL DEFAULT 1,
      gst_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      tax_type VARCHAR(20) NOT NULL DEFAULT 'GST',
      price_inclusive TINYINT(1) NOT NULL DEFAULT 0,
      purchase_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      cost_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      selling_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      mrp DECIMAL(14,2) NOT NULL DEFAULT 0,
      opening_stock DECIMAL(14,3) NOT NULL DEFAULT 0,
      current_stock DECIMAL(14,3) NOT NULL DEFAULT 0,
      reserved_stock DECIMAL(14,3) NOT NULL DEFAULT 0,
      min_stock DECIMAL(14,3) NOT NULL DEFAULT 0,
      reorder_level DECIMAL(14,3) NOT NULL DEFAULT 0,
      reorder_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
      max_stock DECIMAL(14,3) NOT NULL DEFAULT 0,
      valuation_method VARCHAR(20) NOT NULL DEFAULT 'Weighted Average',
      track_inventory TINYINT(1) NOT NULL DEFAULT 1,
      preferred_vendor_id VARCHAR(40) DEFAULT NULL,
      preferred_vendor_name VARCHAR(190) DEFAULT NULL,
      sales_account VARCHAR(120) DEFAULT NULL,
      purchase_account VARCHAR(120) DEFAULT NULL,
      inventory_account VARCHAR(120) DEFAULT NULL,
      image_url VARCHAR(500) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_products_product_id (product_id),
      KEY idx_products_name (name),
      KEY idx_products_category (category),
      KEY idx_products_brand (brand),
      KEY idx_products_hsn (hsn_sac),
      KEY idx_products_status (status),
      KEY idx_products_type (product_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // SKU uniqueness is enforced with a case-insensitive unique index. NULL/blank
  // SKUs are allowed (services often have none) and MySQL permits multiple NULLs.
  await ensureIndex("products", "uq_products_sku", "sku")

  // ── Configurable categories + subcategories ─────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS product_categories (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      parent VARCHAR(120) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_prod_cat (name, parent)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // Seed the configurable default categories once.
  for (const name of DEFAULT_CATEGORIES) {
    await query(`INSERT IGNORE INTO product_categories (name, parent) VALUES (?, NULL)`, [name])
  }

  // ── Price change history ────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS product_price_history (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_pk BIGINT NOT NULL,
      product_id VARCHAR(30) DEFAULT NULL,
      field VARCHAR(30) NOT NULL,
      old_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      new_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      reason VARCHAR(255) DEFAULT NULL,
      changed_by INT DEFAULT NULL,
      changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pph_product (product_pk),
      KEY idx_pph_changed (changed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // ── Inventory ledger — every stock movement is traceable ───────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_pk BIGINT NOT NULL,
      product_id VARCHAR(30) DEFAULT NULL,
      movement_date DATE NOT NULL,
      movement_type VARCHAR(30) NOT NULL,
      reference VARCHAR(160) DEFAULT NULL,
      reference_type VARCHAR(40) DEFAULT NULL,
      reference_id VARCHAR(80) DEFAULT NULL,
      quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
      before_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      after_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
      notes VARCHAR(255) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_ledger_product (product_pk),
      KEY idx_ledger_type (movement_type),
      KEY idx_ledger_ref (reference_type, reference_id),
      UNIQUE KEY uq_ledger_source (reference_type, reference_id, product_pk, movement_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // ── Stock adjustments (authorized, auditable, never silent) ─────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      adjustment_id VARCHAR(30) NOT NULL,
      product_pk BIGINT NOT NULL,
      product_id VARCHAR(30) DEFAULT NULL,
      adjustment_type VARCHAR(20) NOT NULL,
      quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
      before_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      after_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      reason VARCHAR(255) DEFAULT NULL,
      reference VARCHAR(160) DEFAULT NULL,
      adjustment_date DATE NOT NULL,
      user_id INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_stock_adj (adjustment_id),
      KEY idx_adj_product (product_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // ── Product documents (reuses the shared blob storage) ──────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS product_documents (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_pk BIGINT NOT NULL,
      doc_type VARCHAR(40) NOT NULL DEFAULT 'Product Document',
      file_name VARCHAR(255) DEFAULT NULL,
      url VARCHAR(500) NOT NULL,
      uploaded_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pdoc_product (product_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // ── Product ↔ Vendor links (reuses Finance customers_vendors master) ────────
  await query(`
    CREATE TABLE IF NOT EXISTS product_vendors (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_pk BIGINT NOT NULL,
      vendor_id VARCHAR(40) NOT NULL,
      vendor_name VARCHAR(190) DEFAULT NULL,
      vendor_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      is_preferred TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_prod_vendor (product_pk, vendor_id),
      KEY idx_pv_product (product_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // ── Audit trail ─────────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS product_audit (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      product_pk BIGINT DEFAULT NULL,
      product_id VARCHAR(30) DEFAULT NULL,
      action VARCHAR(40) NOT NULL,
      field VARCHAR(60) DEFAULT NULL,
      old_value TEXT DEFAULT NULL,
      new_value TEXT DEFAULT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      user_name VARCHAR(190) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_paudit_product (product_pk),
      KEY idx_paudit_action (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // ── Module configuration (admin-tunable defaults) ───────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS product_settings (
      setting_key VARCHAR(60) NOT NULL PRIMARY KEY,
      setting_value VARCHAR(255) DEFAULT NULL,
      updated_by INT DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  const defaultSettings: Record<string, string> = {
    low_stock_threshold: "0",
    negative_stock_allowed: "0",
    default_unit: "Nos",
    default_gst_rate: "18",
    default_valuation: "Weighted Average",
  }
  for (const [k, v] of Object.entries(defaultSettings)) {
    await query(`INSERT IGNORE INTO product_settings (setting_key, setting_value) VALUES (?, ?)`, [k, v])
  }

  // ── Link product onto EXISTING transaction line tables (non-destructive) ────
  await ensureColumn("sales_invoice_items", "product_id", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn("sales_invoice_items", "product_pk", "BIGINT DEFAULT NULL")
  await ensureIndex("sales_invoice_items", "idx_sii_product", "product_pk")
  await ensureColumn("purchase_bill_items", "product_id", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn("purchase_bill_items", "product_pk", "BIGINT DEFAULT NULL")
  await ensureIndex("purchase_bill_items", "idx_pbi_product", "product_pk")

  ensured = true
}
