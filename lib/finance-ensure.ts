import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing schema for the Freelance Invoices sub-module. The config-driven
 * CRUD factory writes exactly the columns declared in the ModuleConfig, so the
 * new `freelancer_email` field (and the invoice-send tracking columns) must
 * exist before any INSERT/UPDATE runs. MySQL has no "ADD COLUMN IF NOT EXISTS",
 * so we check information_schema first. Runs once per process.
 */
let ensured = false

async function ensureColumn(table: string, column: string, definition: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

export async function ensureFreelanceInvoiceColumns() {
  if (ensured) return
  await ensureColumn("freelance_invoices", "freelancer_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn("freelance_invoices", "invoice_last_sent_at", "DATETIME DEFAULT NULL")
  await ensureColumn("freelance_invoices", "invoice_last_sent_to", "VARCHAR(190) DEFAULT NULL")
  ensured = true
}

let fteEnsured = false

/**
 * Self-healing schema for the FTE Invoices sub-module. Mirrors the freelance
 * helper: the config now carries an `employee_email` recipient field plus the
 * invoice-send tracking columns, none of which exist in the base migration.
 */
export async function ensureFteInvoiceColumns() {
  if (fteEnsured) return
  await ensureColumn("fte_invoices", "employee_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn("fte_invoices", "invoice_last_sent_at", "DATETIME DEFAULT NULL")
  await ensureColumn("fte_invoices", "invoice_last_sent_to", "VARCHAR(190) DEFAULT NULL")
  fteEnsured = true
}
