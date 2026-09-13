import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { resolveCompanyId } from "@/lib/sales/company-master"
import { createContractFromQuotation } from "@/lib/sales/contract-service"
import { attachLeadEvent } from "@/lib/sales/lead-lifecycle"
import { computeQuoteTotals, type DiscountType, type GstTreatment, type TaxMode } from "@/lib/sales/quotation-calc"
import { round2 } from "@/lib/finance-calc"

/* ------------------------------------------------------------------ */
/* Schema self-healing                                                 */
/* ------------------------------------------------------------------ */

let schemaReady = false

async function columnExists(conn: PoolConnection, table: string, column: string) {
  const [rows] = await conn.query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function ensureColumn(conn: PoolConnection, table: string, column: string, definition: string) {
  if (!(await columnExists(conn, table, column))) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function indexExists(conn: PoolConnection, table: string, indexName: string) {
  const [rows] = await conn.query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  )
  return rows.length > 0
}

async function ensureIndex(conn: PoolConnection, table: string, indexName: string, columns: string) {
  if (!(await indexExists(conn, table, indexName))) {
    await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`)
  }
}

/**
 * Idempotently bring the quotation tables up to the current shape. Mirrors
 * database/migrations/2026-09-26-upgrade-sales-quotations.sql so installs that
 * never ran the migration still work. Safe to call on every request (guarded
 * by an in-process flag).
 */
export async function ensureQuotationSchema(): Promise<void> {
  if (schemaReady) return
  const conn = await pool.getConnection()
  try {
    const headerCols: Array<[string, string]> = [
      ["company_id", "INT UNSIGNED DEFAULT NULL"],
      ["contact_id", "INT UNSIGNED DEFAULT NULL"],
      ["lead_id", "INT UNSIGNED DEFAULT NULL"],
      ["meeting_id", "INT UNSIGNED DEFAULT NULL"],
      ["owner_id", "INT UNSIGNED DEFAULT NULL"],
      ["contact_email", "VARCHAR(190) DEFAULT NULL"],
      ["contact_phone", "VARCHAR(60) DEFAULT NULL"],
      ["contact_designation", "VARCHAR(120) DEFAULT NULL"],
      ["reference", "VARCHAR(190) DEFAULT NULL"],
      ["source_type", "VARCHAR(20) DEFAULT 'Manual'"],
      ["source_module", "VARCHAR(40) DEFAULT NULL"],
      ["source_record_id", "VARCHAR(64) DEFAULT NULL"],
      ["bill_to_address", "TEXT DEFAULT NULL"],
      ["ship_to_address", "TEXT DEFAULT NULL"],
      ["place_of_supply", "VARCHAR(80) DEFAULT NULL"],
      ["currency", "VARCHAR(8) NOT NULL DEFAULT 'INR'"],
      ["exchange_rate", "DECIMAL(14,6) NOT NULL DEFAULT 1"],
      ["tax_mode", "ENUM('Exclusive','Inclusive') NOT NULL DEFAULT 'Exclusive'"],
      ["gst_treatment", "ENUM('Intra','Inter','None') NOT NULL DEFAULT 'Intra'"],
      ["subtotal", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["discount_type", "ENUM('none','percent','fixed') NOT NULL DEFAULT 'none'"],
      ["discount_value", "DECIMAL(14,4) NOT NULL DEFAULT 0"],
      ["discount_total", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["taxable_value", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["cgst_total", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["sgst_total", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["igst_total", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["tax_total", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["round_off", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["grand_total", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
      ["payment_terms", "VARCHAR(120) DEFAULT NULL"],
      ["delivery_terms", "VARCHAR(255) DEFAULT NULL"],
      ["terms_text", "TEXT DEFAULT NULL"],
      ["customer_notes", "TEXT DEFAULT NULL"],
      ["internal_notes", "TEXT DEFAULT NULL"],
      ["version", "INT UNSIGNED NOT NULL DEFAULT 1"],
      ["root_id", "INT UNSIGNED DEFAULT NULL"],
      ["superseded_by", "INT UNSIGNED DEFAULT NULL"],
      ["is_current", "TINYINT(1) NOT NULL DEFAULT 1"],
      ["row_version", "INT UNSIGNED NOT NULL DEFAULT 1"],
      ["sent_at", "DATETIME DEFAULT NULL"],
      ["viewed_at", "DATETIME DEFAULT NULL"],
      ["accepted_at", "DATETIME DEFAULT NULL"],
      ["accepted_by", "INT UNSIGNED DEFAULT NULL"],
      ["rejected_at", "DATETIME DEFAULT NULL"],
      ["rejected_by", "INT UNSIGNED DEFAULT NULL"],
      ["rejection_reason", "VARCHAR(120) DEFAULT NULL"],
      ["rejection_notes", "TEXT DEFAULT NULL"],
      ["converted_contract_id", "INT UNSIGNED DEFAULT NULL"],
      ["converted_invoice_id", "INT UNSIGNED DEFAULT NULL"],
      ["cancelled_at", "DATETIME DEFAULT NULL"],
      ["archived_at", "DATETIME DEFAULT NULL"],
    ]
    for (const [col, def] of headerCols) await ensureColumn(conn, "sales_quotations", col, def)

    // Widen status enum to include Cancelled (safe to re-run).
    await conn
      .query(
        `ALTER TABLE \`sales_quotations\` MODIFY COLUMN \`status\`
         ENUM('Draft','Sent','Accepted','Rejected','Expired','Cancelled') NOT NULL DEFAULT 'Draft'`,
      )
      .catch(() => {})

    // Quote code unique per version rather than globally.
    if (await indexExists(conn, "sales_quotations", "uniq_quote_code")) {
      await conn.query("ALTER TABLE `sales_quotations` DROP INDEX `uniq_quote_code`").catch(() => {})
    }
    await ensureIndex(conn, "sales_quotations", "uniq_quote_code_version", "`quote_code`, `version`").catch(() => {})
    await ensureIndex(conn, "sales_quotations", "idx_quotations_company", "`company_id`")
    await ensureIndex(conn, "sales_quotations", "idx_quotations_status", "`status`")
    await ensureIndex(conn, "sales_quotations", "idx_quotations_root", "`root_id`")

    await conn.query("UPDATE `sales_quotations` SET `root_id` = `id` WHERE `root_id` IS NULL")
    await conn.query(
      `UPDATE \`sales_quotations\`
         SET \`grand_total\` = \`total_amount\`, \`subtotal\` = \`total_amount\`, \`taxable_value\` = \`total_amount\`
       WHERE \`grand_total\` = 0 AND \`total_amount\` <> 0`,
    )

    await conn.query(
      `CREATE TABLE IF NOT EXISTS \`sales_quotation_items\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`quotation_id\` INT UNSIGNED NOT NULL,
        \`line_no\` INT UNSIGNED NOT NULL DEFAULT 1,
        \`item_type\` VARCHAR(30) NOT NULL DEFAULT 'Service',
        \`name\` VARCHAR(255) NOT NULL,
        \`description\` TEXT DEFAULT NULL,
        \`hsn_sac\` VARCHAR(20) DEFAULT NULL,
        \`quantity\` DECIMAL(14,3) NOT NULL DEFAULT 1,
        \`unit\` VARCHAR(30) DEFAULT NULL,
        \`rate\` DECIMAL(14,4) NOT NULL DEFAULT 0,
        \`discount_type\` ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
        \`discount_value\` DECIMAL(14,4) NOT NULL DEFAULT 0,
        \`discount_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`tax_rate\` DECIMAL(6,3) NOT NULL DEFAULT 0,
        \`taxable_value\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`cgst\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`sgst\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`igst\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`tax_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`line_total\` DECIMAL(14,2) NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_quotation_items_quote\` (\`quotation_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    )

    await conn.query(
      `CREATE TABLE IF NOT EXISTS \`sales_quotation_events\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`quotation_id\` INT UNSIGNED NOT NULL,
        \`event_type\` VARCHAR(40) NOT NULL,
        \`description\` VARCHAR(500) DEFAULT NULL,
        \`meta\` JSON DEFAULT NULL,
        \`actor_id\` INT UNSIGNED DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_quotation_events_quote\` (\`quotation_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    )

    await ensureColumn(conn, "sales_contracts", "source_quotation_id", "INT UNSIGNED DEFAULT NULL")
    await ensureColumn(conn, "sales_invoices", "source_quotation_id", "INT UNSIGNED DEFAULT NULL").catch(() => {})

    schemaReady = true
  } finally {
    conn.release()
  }
}

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Allocate the next MQ-xxx quote code inside the caller's transaction.
 * Seeds record_id_sequences from the current max so legacy MQ-001.. numbers are
 * never reissued, then atomically increments under FOR UPDATE.
 */
async function nextQuotationCode(conn: PoolConnection): Promise<string> {
  const [maxRows] = await conn.query<any[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(quote_code, 4) AS UNSIGNED)), 0) AS m FROM sales_quotations",
  )
  const currentMax = Number(maxRows[0]?.m || 0)
  await conn.query(
    "INSERT INTO record_id_sequences (prefix, next_number) VALUES ('MQ', ?) ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, ?)",
    [currentMax, currentMax],
  )
  await conn.query("UPDATE record_id_sequences SET next_number = next_number + 1 WHERE prefix = 'MQ'")
  const [rows] = await conn.query<any[]>("SELECT next_number FROM record_id_sequences WHERE prefix = 'MQ' FOR UPDATE")
  const n = Number(rows[0]?.next_number || currentMax + 1)
  return `MQ-${String(n).padStart(3, "0")}`
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type QuotationItemInput = {
  item_type?: string
  name: string
  description?: string | null
  hsn_sac?: string | null
  quantity?: number | string
  unit?: string | null
  rate?: number | string
  discount_type?: DiscountType
  discount_value?: number | string
  tax_rate?: number | string
}

export type QuotationInput = {
  company_id?: number | null
  company_name?: string | null
  contact_id?: number | null
  contact_person?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  contact_designation?: string | null
  lead_id?: number | null
  meeting_id?: number | null
  owner_id?: number | null
  opportunity_name?: string | null
  reference?: string | null
  quote_date?: string | null
  valid_until?: string | null
  currency?: string | null
  exchange_rate?: number | string | null
  tax_mode?: TaxMode
  gst_treatment?: GstTreatment
  place_of_supply?: string | null
  bill_to_address?: string | null
  ship_to_address?: string | null
  discount_type?: DiscountType
  discount_value?: number | string
  round_off?: boolean
  payment_terms?: string | null
  delivery_terms?: string | null
  terms_text?: string | null
  customer_notes?: string | null
  internal_notes?: string | null
  source_type?: string | null
  source_module?: string | null
  source_record_id?: string | null
  items: QuotationItemInput[]
}

const ACTIVE_STATUSES = ["Draft", "Sent", "Accepted", "Rejected", "Expired", "Cancelled"] as const
export type QuotationStatus = (typeof ACTIVE_STATUSES)[number]

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export async function logQuotationEvent(input: {
  quotationId: number
  type: string
  description?: string
  meta?: Record<string, any>
  actorId?: number | null
  conn?: PoolConnection
}): Promise<void> {
  const runner = input.conn ?? pool
  await runner
    .query(
      `INSERT INTO sales_quotation_events (quotation_id, event_type, description, meta, actor_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.quotationId,
        input.type,
        input.description ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        input.actorId ?? null,
      ],
    )
    .catch(() => {})
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function normalizeItems(items: QuotationItemInput[]) {
  return (items || [])
    .filter((i) => i && i.name && String(i.name).trim() !== "")
    .map((i) => ({
      item_type: i.item_type || "Service",
      name: String(i.name).trim(),
      description: i.description ?? null,
      hsn_sac: i.hsn_sac ?? null,
      quantity: i.quantity ?? 1,
      unit: i.unit ?? null,
      rate: i.rate ?? 0,
      discount_type: (i.discount_type || "none") as DiscountType,
      discount_value: i.discount_value ?? 0,
      tax_rate: i.tax_rate ?? 0,
    }))
}

async function persistItemsAndTotals(
  conn: PoolConnection,
  quotationId: number,
  input: QuotationInput,
): Promise<ReturnType<typeof computeQuoteTotals>> {
  const items = normalizeItems(input.items)
  const totals = computeQuoteTotals({
    items,
    taxMode: input.tax_mode === "Inclusive" ? "Inclusive" : "Exclusive",
    gstTreatment: (input.gst_treatment as GstTreatment) || "Intra",
    globalDiscountType: input.discount_type || "none",
    globalDiscountValue: input.discount_value || 0,
    roundOff: Boolean(input.round_off),
  })

  await conn.query("DELETE FROM sales_quotation_items WHERE quotation_id = ?", [quotationId])
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx]
    const t = totals.lines[idx]
    await conn.query(
      `INSERT INTO sales_quotation_items
       (quotation_id, line_no, item_type, name, description, hsn_sac, quantity, unit, rate,
        discount_type, discount_value, discount_amount, tax_rate, taxable_value, cgst, sgst, igst, tax_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quotationId,
        idx + 1,
        it.item_type,
        it.name,
        it.description,
        it.hsn_sac,
        t.quantity,
        it.unit,
        t.rate,
        it.discount_type,
        Number(it.discount_value) || 0,
        t.discountAmount,
        t.taxRate,
        t.taxableValue,
        t.cgst,
        t.sgst,
        t.igst,
        t.taxAmount,
        t.lineTotal,
      ],
    )
  }

  await conn.query(
    `UPDATE sales_quotations SET
       subtotal = ?, discount_type = ?, discount_value = ?, discount_total = ?,
       taxable_value = ?, cgst_total = ?, sgst_total = ?, igst_total = ?, tax_total = ?,
       round_off = ?, grand_total = ?, total_amount = ?
     WHERE id = ?`,
    [
      totals.subtotal,
      input.discount_type || "none",
      Number(input.discount_value) || 0,
      totals.discountTotal,
      totals.taxableValue,
      totals.cgstTotal,
      totals.sgstTotal,
      totals.igstTotal,
      totals.taxTotal,
      totals.roundOff,
      totals.grandTotal,
      totals.grandTotal,
      quotationId,
    ],
  )

  return totals
}

export async function createQuotation(
  input: QuotationInput,
  actorId: number,
): Promise<{ id: number; quote_code: string }> {
  await ensureQuotationSchema()
  const companyId = await resolveCompanyId({ company_id: input.company_id, company_name: input.company_name })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const quoteCode = await nextQuotationCode(conn)

    const [res] = await conn.query<any>(
      `INSERT INTO sales_quotations
       (quote_code, quote_date, company_name, company_id, contact_id, contact_person, contact_email,
        contact_phone, contact_designation, opportunity_name, reference, lead_id, meeting_id, owner_id,
        currency, exchange_rate, tax_mode, gst_treatment, place_of_supply, bill_to_address, ship_to_address,
        payment_terms, delivery_terms, terms_text, customer_notes, internal_notes,
        source_type, source_module, source_record_id, valid_until, status, version, is_current, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 1, 1, ?)`,
      [
        quoteCode,
        input.quote_date || new Date().toISOString().slice(0, 10),
        input.company_name || null,
        companyId,
        input.contact_id || null,
        input.contact_person || null,
        input.contact_email || null,
        input.contact_phone || null,
        input.contact_designation || null,
        input.opportunity_name || null,
        input.reference || null,
        input.lead_id || null,
        input.meeting_id || null,
        input.owner_id || actorId,
        (input.currency || "INR").toUpperCase(),
        Number(input.exchange_rate) || 1,
        input.tax_mode === "Inclusive" ? "Inclusive" : "Exclusive",
        (input.gst_treatment as GstTreatment) || "Intra",
        input.place_of_supply || null,
        input.bill_to_address || null,
        input.ship_to_address || null,
        input.payment_terms || null,
        input.delivery_terms || null,
        input.terms_text || null,
        input.customer_notes || null,
        input.internal_notes || null,
        input.source_type || "Manual",
        input.source_module || null,
        input.source_record_id || null,
        input.valid_until || null,
        actorId,
      ],
    )
    const id = res.insertId as number
    await conn.query("UPDATE sales_quotations SET root_id = id WHERE id = ?", [id])
    const totals = await persistItemsAndTotals(conn, id, input)
    await logQuotationEvent({
      quotationId: id,
      type: "created",
      description: `Quotation ${quoteCode} created`,
      meta: { grandTotal: totals.grandTotal },
      actorId,
      conn,
    })
    await conn.commit()

    if (input.lead_id) {
      await attachLeadEvent({
        leadId: Number(input.lead_id),
        type: "quotation",
        title: `Quotation ${quoteCode} created`,
        body: `Total ${totals.grandTotal}`,
        refType: "quotation",
        refId: id,
        actorId,
      }).catch(() => {})
    }
    return { id, quote_code: quoteCode }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/* ------------------------------------------------------------------ */
/* Update (draft only)                                                 */
/* ------------------------------------------------------------------ */

export async function updateDraftQuotation(id: number, input: QuotationInput, actorId: number): Promise<void> {
  await ensureQuotationSchema()
  const rows = await query<any[]>("SELECT status FROM sales_quotations WHERE id = ?", [id])
  const existing = rows[0]
  if (!existing) throw new QuotationError("Quotation not found", 404)
  if (existing.status !== "Draft") {
    throw new QuotationError("Only draft quotations can be edited. Create a revision to change a sent quotation.", 409)
  }
  const companyId = await resolveCompanyId({ company_id: input.company_id, company_name: input.company_name })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE sales_quotations SET
        company_name = ?, company_id = ?, contact_id = ?, contact_person = ?, contact_email = ?,
        contact_phone = ?, contact_designation = ?, opportunity_name = ?, reference = ?, lead_id = ?,
        meeting_id = ?, owner_id = ?, currency = ?, exchange_rate = ?, tax_mode = ?, gst_treatment = ?,
        place_of_supply = ?, bill_to_address = ?, ship_to_address = ?, payment_terms = ?, delivery_terms = ?,
        terms_text = ?, customer_notes = ?, internal_notes = ?, quote_date = ?, valid_until = ?,
        row_version = row_version + 1
       WHERE id = ?`,
      [
        input.company_name || null,
        companyId,
        input.contact_id || null,
        input.contact_person || null,
        input.contact_email || null,
        input.contact_phone || null,
        input.contact_designation || null,
        input.opportunity_name || null,
        input.reference || null,
        input.lead_id || null,
        input.meeting_id || null,
        input.owner_id || actorId,
        (input.currency || "INR").toUpperCase(),
        Number(input.exchange_rate) || 1,
        input.tax_mode === "Inclusive" ? "Inclusive" : "Exclusive",
        (input.gst_treatment as GstTreatment) || "Intra",
        input.place_of_supply || null,
        input.bill_to_address || null,
        input.ship_to_address || null,
        input.payment_terms || null,
        input.delivery_terms || null,
        input.terms_text || null,
        input.customer_notes || null,
        input.internal_notes || null,
        input.quote_date || null,
        input.valid_until || null,
        id,
      ],
    )
    await persistItemsAndTotals(conn, id, input)
    await logQuotationEvent({ quotationId: id, type: "updated", description: "Draft updated", actorId, conn })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

export async function listQuotations(filters: {
  status?: string
  companyId?: number
  search?: string
  includeArchived?: boolean
  onlyCurrent?: boolean
}) {
  await ensureQuotationSchema()
  const where: string[] = []
  const params: any[] = []
  if (!filters.includeArchived) where.push("q.archived_at IS NULL")
  if (filters.onlyCurrent) where.push("q.is_current = 1")
  if (filters.status && filters.status !== "All") {
    where.push("q.status = ?")
    params.push(filters.status)
  }
  if (filters.companyId) {
    where.push("q.company_id = ?")
    params.push(filters.companyId)
  }
  if (filters.search) {
    where.push("(q.company_name LIKE ? OR q.contact_person LIKE ? OR q.opportunity_name LIKE ? OR q.quote_code LIKE ?)")
    const s = `%${filters.search}%`
    params.push(s, s, s, s)
  }
  const sql = `
    SELECT q.*, u.name AS added_by_name, o.name AS owner_name
    FROM sales_quotations q
    LEFT JOIN users u ON u.id = q.added_by
    LEFT JOIN users o ON o.id = q.owner_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY q.created_at DESC`
  return query<any[]>(sql, params)
}

export async function getQuotationDetail(id: number) {
  await ensureQuotationSchema()
  const rows = await query<any[]>(
    `SELECT q.*, u.name AS added_by_name, o.name AS owner_name
     FROM sales_quotations q
     LEFT JOIN users u ON u.id = q.added_by
     LEFT JOIN users o ON o.id = q.owner_id
     WHERE q.id = ?`,
    [id],
  )
  const quotation = rows[0]
  if (!quotation) return null
  const items = await query<any[]>(
    "SELECT * FROM sales_quotation_items WHERE quotation_id = ? ORDER BY line_no ASC",
    [id],
  )
  const events = await query<any[]>(
    `SELECT e.*, u.name AS actor_name FROM sales_quotation_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.quotation_id = ? ORDER BY e.created_at DESC, e.id DESC`,
    [id],
  )
  const versions = await query<any[]>(
    `SELECT id, quote_code, version, status, grand_total, is_current, created_at
     FROM sales_quotations WHERE root_id = ? ORDER BY version ASC`,
    [quotation.root_id || id],
  )
  return { quotation, items, events, versions }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export class QuotationError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

async function loadQuotation(id: number) {
  const rows = await query<any[]>("SELECT * FROM sales_quotations WHERE id = ?", [id])
  if (!rows[0]) throw new QuotationError("Quotation not found", 404)
  return rows[0]
}

/** Mark a quotation Sent. Optionally records that an email was dispatched. */
export async function markQuotationSent(id: number, actorId: number, via = "email"): Promise<void> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  if (["Cancelled", "Rejected", "Expired"].includes(q.status)) {
    throw new QuotationError(`A ${q.status.toLowerCase()} quotation cannot be sent.`, 409)
  }
  await query(
    "UPDATE sales_quotations SET status = 'Sent', sent_at = COALESCE(sent_at, NOW()) WHERE id = ?",
    [id],
  )
  await logQuotationEvent({ quotationId: id, type: "sent", description: `Sent via ${via}`, actorId })
  if (q.lead_id) {
    await attachLeadEvent({
      leadId: Number(q.lead_id),
      type: "quotation",
      title: `Quotation ${q.quote_code} sent`,
      refType: "quotation",
      refId: id,
      actorId,
    }).catch(() => {})
  }
}

export async function acceptQuotation(id: number, actorId: number, note?: string): Promise<void> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  if (!["Sent", "Draft"].includes(q.status)) {
    throw new QuotationError(`Only a sent quotation can be accepted (current: ${q.status}).`, 409)
  }
  await query("UPDATE sales_quotations SET status = 'Accepted', accepted_at = NOW(), accepted_by = ? WHERE id = ?", [
    actorId,
    id,
  ])
  await logQuotationEvent({ quotationId: id, type: "accepted", description: note || "Marked accepted", actorId })
  if (q.lead_id) {
    await attachLeadEvent({
      leadId: Number(q.lead_id),
      type: "quotation",
      title: `Quotation ${q.quote_code} accepted`,
      refType: "quotation",
      refId: id,
      actorId,
    }).catch(() => {})
  }
}

export async function rejectQuotation(
  id: number,
  actorId: number,
  reason?: string,
  notes?: string,
): Promise<void> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  if (!["Sent", "Draft"].includes(q.status)) {
    throw new QuotationError(`Only a sent quotation can be rejected (current: ${q.status}).`, 409)
  }
  await query(
    "UPDATE sales_quotations SET status = 'Rejected', rejected_at = NOW(), rejected_by = ?, rejection_reason = ?, rejection_notes = ? WHERE id = ?",
    [actorId, reason || null, notes || null, id],
  )
  await logQuotationEvent({
    quotationId: id,
    type: "rejected",
    description: reason ? `Rejected: ${reason}` : "Rejected",
    actorId,
  })
}

export async function cancelQuotation(id: number, actorId: number, reason?: string): Promise<void> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  if (["Accepted", "Cancelled"].includes(q.status)) {
    throw new QuotationError(`A ${q.status.toLowerCase()} quotation cannot be cancelled.`, 409)
  }
  await query("UPDATE sales_quotations SET status = 'Cancelled', cancelled_at = NOW() WHERE id = ?", [id])
  await logQuotationEvent({ quotationId: id, type: "cancelled", description: reason || "Cancelled", actorId })
}

export async function archiveQuotation(id: number, actorId: number): Promise<void> {
  await ensureQuotationSchema()
  await query("UPDATE sales_quotations SET archived_at = NOW() WHERE id = ?", [id])
  await logQuotationEvent({ quotationId: id, type: "archived", description: "Archived", actorId })
}

export async function renewValidity(id: number, validUntil: string, actorId: number): Promise<void> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  const newStatus = q.status === "Expired" ? "Sent" : q.status
  await query("UPDATE sales_quotations SET valid_until = ?, status = ? WHERE id = ?", [validUntil, newStatus, id])
  await logQuotationEvent({
    quotationId: id,
    type: "renewed",
    description: `Validity extended to ${validUntil}`,
    actorId,
  })
}

/**
 * Expire quotations whose validity has lapsed. Returns the number expired.
 * Safe to call from a scheduler or on page load.
 */
export async function expireOverdueQuotations(): Promise<number> {
  await ensureQuotationSchema()
  const due = await query<any[]>(
    "SELECT id FROM sales_quotations WHERE status = 'Sent' AND valid_until IS NOT NULL AND valid_until < CURDATE() AND archived_at IS NULL",
  )
  if (due.length === 0) return 0
  const ids = due.map((r) => r.id)
  await query(
    `UPDATE sales_quotations SET status = 'Expired' WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  )
  for (const id of ids) {
    await logQuotationEvent({ quotationId: id, type: "expired", description: "Auto-expired (validity lapsed)" })
  }
  return ids.length
}

/* ------------------------------------------------------------------ */
/* Revise / Duplicate                                                  */
/* ------------------------------------------------------------------ */

/** Clone a quotation's header + items via SQL, returning the new row id. */
async function cloneRow(
  conn: PoolConnection,
  source: any,
  overrides: Record<string, any>,
): Promise<number> {
  const base: Record<string, any> = {
    quote_code: source.quote_code,
    quote_date: new Date().toISOString().slice(0, 10),
    company_name: source.company_name,
    company_id: source.company_id,
    contact_id: source.contact_id,
    contact_person: source.contact_person,
    contact_email: source.contact_email,
    contact_phone: source.contact_phone,
    contact_designation: source.contact_designation,
    opportunity_name: source.opportunity_name,
    reference: source.reference,
    lead_id: source.lead_id,
    meeting_id: source.meeting_id,
    owner_id: source.owner_id,
    currency: source.currency,
    exchange_rate: source.exchange_rate,
    tax_mode: source.tax_mode,
    gst_treatment: source.gst_treatment,
    place_of_supply: source.place_of_supply,
    bill_to_address: source.bill_to_address,
    ship_to_address: source.ship_to_address,
    payment_terms: source.payment_terms,
    delivery_terms: source.delivery_terms,
    terms_text: source.terms_text,
    customer_notes: source.customer_notes,
    internal_notes: source.internal_notes,
    source_type: source.source_type,
    source_module: source.source_module,
    source_record_id: source.source_record_id,
    valid_until: source.valid_until,
    status: "Draft",
    version: 1,
    root_id: null,
    is_current: 1,
    subtotal: source.subtotal,
    discount_type: source.discount_type,
    discount_value: source.discount_value,
    discount_total: source.discount_total,
    taxable_value: source.taxable_value,
    cgst_total: source.cgst_total,
    sgst_total: source.sgst_total,
    igst_total: source.igst_total,
    tax_total: source.tax_total,
    round_off: source.round_off,
    grand_total: source.grand_total,
    total_amount: source.total_amount,
    added_by: source.added_by,
    ...overrides,
  }
  const cols = Object.keys(base)
  const [res] = await conn.query<any>(
    `INSERT INTO sales_quotations (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    cols.map((c) => base[c]),
  )
  const newId = res.insertId as number

  const items = await conn.query<any[]>("SELECT * FROM sales_quotation_items WHERE quotation_id = ? ORDER BY line_no ASC", [
    source.id,
  ])
  for (const it of items[0] as any[]) {
    await conn.query(
      `INSERT INTO sales_quotation_items
       (quotation_id, line_no, item_type, name, description, hsn_sac, quantity, unit, rate,
        discount_type, discount_value, discount_amount, tax_rate, taxable_value, cgst, sgst, igst, tax_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId,
        it.line_no,
        it.item_type,
        it.name,
        it.description,
        it.hsn_sac,
        it.quantity,
        it.unit,
        it.rate,
        it.discount_type,
        it.discount_value,
        it.discount_amount,
        it.tax_rate,
        it.taxable_value,
        it.cgst,
        it.sgst,
        it.igst,
        it.tax_amount,
        it.line_total,
      ],
    )
  }
  return newId
}

/**
 * Create a new revision of a quotation. The new row keeps the same quote_code
 * with an incremented version, becomes the current version (Draft), and the
 * previous version is superseded.
 */
export async function reviseQuotation(id: number, actorId: number): Promise<{ id: number; version: number }> {
  await ensureQuotationSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [srcRows] = await conn.query<any[]>("SELECT * FROM sales_quotations WHERE id = ? FOR UPDATE", [id])
    const source = srcRows[0]
    if (!source) throw new QuotationError("Quotation not found", 404)
    const rootId = source.root_id || source.id
    const [maxRows] = await conn.query<any[]>(
      "SELECT COALESCE(MAX(version), 1) AS v FROM sales_quotations WHERE root_id = ?",
      [rootId],
    )
    const nextVersion = Number(maxRows[0]?.v || 1) + 1
    const newId = await cloneRow(conn, source, {
      version: nextVersion,
      root_id: rootId,
      status: "Draft",
      is_current: 1,
    })
    await conn.query("UPDATE sales_quotations SET is_current = 0, superseded_by = ? WHERE root_id = ? AND id <> ?", [
      newId,
      rootId,
      newId,
    ])
    await logQuotationEvent({
      quotationId: newId,
      type: "revised",
      description: `Revision V${nextVersion} created from V${source.version}`,
      actorId,
      conn,
    })
    await conn.commit()
    return { id: newId, version: nextVersion }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Duplicate a quotation as a brand-new quote (fresh number, its own root). */
export async function duplicateQuotation(id: number, actorId: number): Promise<{ id: number; quote_code: string }> {
  await ensureQuotationSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [srcRows] = await conn.query<any[]>("SELECT * FROM sales_quotations WHERE id = ?", [id])
    const source = srcRows[0]
    if (!source) throw new QuotationError("Quotation not found", 404)
    const quoteCode = await nextQuotationCode(conn)
    const newId = await cloneRow(conn, source, { quote_code: quoteCode, version: 1, status: "Draft" })
    await conn.query("UPDATE sales_quotations SET root_id = id WHERE id = ?", [newId])
    await logQuotationEvent({
      quotationId: newId,
      type: "duplicated",
      description: `Duplicated from ${source.quote_code}`,
      actorId,
      conn,
    })
    await conn.commit()
    return { id: newId, quote_code: quoteCode }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/* ------------------------------------------------------------------ */
/* Conversions                                                         */
/* ------------------------------------------------------------------ */

export async function convertToContract(
  id: number,
  actorId: number,
  opts: { start_date?: string; end_date?: string; contract_type?: string } = {},
): Promise<{ contract_id: number; contract_code: string }> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  if (q.status !== "Accepted") {
    throw new QuotationError("Only an accepted quotation can be converted to a contract.", 409)
  }
  if (q.converted_contract_id) {
    throw new QuotationError("This quotation has already been converted to a contract.", 409)
  }
  // Delegate to the canonical contract service so the new contract shares the
  // same safe numbering (CON-0001), company linkage, root/version tracking, and
  // append-only timeline as every other contract. No second insert path here.
  const { id: contractId, contract_code: contractCode } = await createContractFromQuotation(q, actorId, opts)

  await query("UPDATE sales_quotations SET converted_contract_id = ? WHERE id = ?", [contractId, id])
  await logQuotationEvent({
    quotationId: id,
    type: "converted_contract",
    description: `Converted to contract ${contractCode}`,
    meta: { contractId, contractCode },
    actorId,
  })
  if (q.lead_id) {
    await attachLeadEvent({
      leadId: Number(q.lead_id),
      type: "contract",
      title: `Quotation ${q.quote_code} converted to contract ${contractCode}`,
      refType: "contract",
      refId: contractId,
      actorId,
    }).catch(() => {})
  }
  return { contract_id: contractId, contract_code: contractCode }
}

export async function convertToInvoice(id: number, actorId: number): Promise<{ invoice_id: number; invoice_code: string }> {
  await ensureQuotationSchema()
  const q = await loadQuotation(id)
  if (q.status !== "Accepted") {
    throw new QuotationError("Only an accepted quotation can be converted to an invoice.", 409)
  }
  if (q.converted_invoice_id) {
    throw new QuotationError("This quotation has already been converted to an invoice.", 409)
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [maxRows] = await conn.query<any[]>(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_id, 5) AS UNSIGNED)), 0) + 1 AS next FROM sales_invoices",
    )
    const invoiceCode = `INV-${String(Number(maxRows[0]?.next || 1)).padStart(4, "0")}`
    const [res] = await conn.query<any>(
      `INSERT INTO sales_invoices
       (invoice_id, invoice_date, invoice_type, client_name, description, taxable_amount, discount,
        cgst_amount, sgst_amount, igst_amount, invoice_total, net_receivable, outstanding_amount,
        payment_status, invoice_status, source_quotation_id, created_by)
       VALUES (?, ?, 'Tax Invoice', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', 'Draft', ?, ?)`,
      [
        invoiceCode,
        new Date().toISOString().slice(0, 10),
        q.company_name,
        q.opportunity_name || `From quotation ${q.quote_code}`,
        q.taxable_value,
        q.discount_total,
        q.cgst_total,
        q.sgst_total,
        q.igst_total,
        q.grand_total,
        q.grand_total,
        q.grand_total,
        id,
        actorId,
      ],
    ).catch((e: any) => {
      // sales_invoices column shape varies across installs; surface a clear error.
      throw new QuotationError(`Could not create invoice: ${e?.message || e}`, 500)
    })
    const invoiceId = (res as any).insertId as number
    await conn.query("UPDATE sales_quotations SET converted_invoice_id = ? WHERE id = ?", [invoiceId, id])
    await logQuotationEvent({
      quotationId: id,
      type: "converted_invoice",
      description: `Converted to invoice ${invoiceCode}`,
      meta: { invoiceId, invoiceCode },
      actorId,
      conn,
    })
    await conn.commit()
    return { invoice_id: invoiceId, invoice_code: invoiceCode }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

export async function getQuotationAnalytics() {
  await ensureQuotationSchema()
  const byStatus = await query<any[]>(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS value
     FROM sales_quotations WHERE archived_at IS NULL AND is_current = 1
     GROUP BY status`,
  )
  const totals = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(grand_total), 0) AS pipeline_value,
       COALESCE(SUM(CASE WHEN status = 'Accepted' THEN grand_total ELSE 0 END), 0) AS won_value,
       SUM(status = 'Accepted') AS accepted,
       SUM(status = 'Rejected') AS rejected,
       SUM(status = 'Sent') AS sent,
       SUM(status = 'Draft') AS draft
     FROM sales_quotations WHERE archived_at IS NULL AND is_current = 1`,
  )
  const t = totals[0] || {}
  const decided = Number(t.accepted || 0) + Number(t.rejected || 0)
  const winRate = decided > 0 ? round2((Number(t.accepted || 0) / decided) * 100) : 0
  return {
    byStatus,
    total: Number(t.total || 0),
    pipelineValue: Number(t.pipeline_value || 0),
    wonValue: Number(t.won_value || 0),
    accepted: Number(t.accepted || 0),
    rejected: Number(t.rejected || 0),
    sent: Number(t.sent || 0),
    draft: Number(t.draft || 0),
    winRate,
  }
}
