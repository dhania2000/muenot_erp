import "server-only"
import { pool, query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import { computeFteBilling, fteFinancialPeriod, autoPaymentStatus, num, round2 } from "@/lib/finance-calc"

/**
 * FTE Invoice server engine (Phases 1–25).
 *
 * Owns everything about an FTE (client-billing) invoice that must NOT be trusted
 * to the browser:
 *   - the immutable, server-generated, concurrency-safe FTE Invoice ID (Phase 7);
 *   - the authoritative Client / Project / Employee snapshots pulled from their
 *     respective masters (Phases 2–5) — the client invoice never duplicates the
 *     Client master, it freezes a copy of it;
 *   - the centralized financial period (Phase 9) and the authoritative client
 *     billing / employee-cost / margin recalculation (Phases 10–18);
 *   - hard resource + relationship validation (Phases 6, 19, 24) and duplicate
 *     detection (Phase 20).
 *
 * Employee PAYROLL deductions (PF/ESI/PT/TDS on salary) are never mixed into the
 * client invoice. Employer cost lives on a separate ledger and only feeds margin.
 */

const FY_START_MONTH: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }

/** Financial-year start calendar year for a date, honouring company settings. */
function fyStartYear(dateStr: string | null | undefined, startMonth: number): number {
  const d = dateStr ? new Date(dateStr) : new Date()
  const valid = !Number.isNaN(d.getTime()) ? d : new Date()
  const y = valid.getFullYear()
  return valid.getMonth() >= startMonth ? y : y - 1
}

/**
 * Generate the next FTE Invoice ID: `FTE-2026-000001` (Phase 7).
 *
 * The number is scoped to the financial year and drawn from the shared
 * `record_id_sequences` table inside a transaction with `FOR UPDATE`, so it is
 * unique and concurrency-safe (never MAX+1). The returned id is immutable — the
 * CRUD factory never rewrites the id column on update.
 */
export async function nextFteInvoiceId(invoiceDate?: string | null): Promise<string> {
  const settings = await getSettings().catch(() => ({}) as Record<string, string>)
  const startMonth = FY_START_MONTH[settings["app.financial_year_start"] as string] ?? 3
  const year = fyStartYear(invoiceDate, startMonth)
  const seqKey = `FTE${year}`

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      "INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1",
      [seqKey],
    )
    const [rows] = await connection.query<any[]>(
      "SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE",
      [seqKey],
    )
    const number = Number(rows[0]?.next_number || 1)
    await connection.commit()
    return `FTE-${year}-${String(number).padStart(6, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

// ---------------------------------------------------------------------------
// Master snapshots (Phases 2–5). Each loader is guarded so a missing table or
// unmatched id never throws — it simply leaves the snapshot empty.
// ---------------------------------------------------------------------------

async function loadClient(clientId?: string | null): Promise<Record<string, any> | null> {
  const id = String(clientId ?? "").trim()
  if (!id) return null
  const rows = (await query(
    `SELECT client_code, client_name, company_name, legal_name, gst_number, pan,
            address, city, state, state_code, postal_code, currency,
            payment_terms_days, email, status
       FROM clients WHERE client_code = ? AND archived_at IS NULL LIMIT 1`,
    [id],
  ).catch(() => [] as any[])) as any[]
  return rows[0] ?? null
}

async function loadProject(projectId?: string | null): Promise<Record<string, any> | null> {
  const id = String(projectId ?? "").trim()
  if (!id) return null
  const rows = (await query(
    `SELECT project_id, project_name, client_name, status
       FROM operations_projects WHERE project_id = ? LIMIT 1`,
    [id],
  ).catch(() => [] as any[])) as any[]
  return rows[0] ?? null
}

async function loadEmployee(employeeId?: string | null): Promise<Record<string, any> | null> {
  const id = String(employeeId ?? "").trim()
  if (!id) return null
  const rows = (await query(
    `SELECT employee_id, employee_name, department, designation, employment_type,
            employment_status, official_email, personal_email
       FROM hr_employees WHERE employee_id = ? LIMIT 1`,
    [id],
  ).catch(() => [] as any[])) as any[]
  return rows[0] ?? null
}

const str = (v: any) => (v == null ? "" : String(v))

/**
 * Server-authoritative FTE recomputation (SERVER_AUGMENT hook).
 *
 * Runs after the pure `compute` and BEFORE validation, so the snapshot fields it
 * writes (client_status / project_status / employee_status / project_client_name)
 * are what the sync validator inspects. Its output overrides anything the browser
 * sent for these columns.
 */
export async function computeFteServerFields(
  merged: Record<string, any>,
  opts: { isCreate: boolean },
): Promise<Record<string, any>> {
  const out: Record<string, any> = {}

  // --- Client snapshot (Phase 2/3) — freeze a copy of the Clients master. -----
  const client = await loadClient(merged.client_id)
  if (client) {
    out.client_name = client.client_name ?? merged.client_name ?? null
    out.client_legal_name = client.legal_name || client.company_name || null
    out.client_gstin = client.gst_number ?? null
    out.client_pan = client.pan ?? null
    out.billing_address =
      merged.billing_address ||
      [client.address, client.city, client.state].filter((x: any) => str(x).trim()).join(", ") ||
      null
    out.client_state = client.state ?? null
    out.client_state_code = client.state_code ?? null
    out.client_pin = client.postal_code ?? null
    out.currency = client.currency || merged.currency || "INR"
    out.payment_terms =
      merged.payment_terms ||
      (client.payment_terms_days != null ? `${client.payment_terms_days} days` : null)
    out.billing_email = merged.billing_email || client.email || null
    out.contact_person = merged.contact_person || client.client_name || null
    out.client_status = client.status ?? null
  }

  // --- Project snapshot (Phase 4). --------------------------------------------
  const project = await loadProject(merged.project_id)
  if (project) {
    out.project_name = project.project_name ?? merged.project_name ?? null
    out.project_status = project.status ?? null
    out.project_client_name = project.client_name ?? null
  }

  // --- Employee snapshot (Phase 5) — identity + role from HR. -----------------
  const employee = await loadEmployee(merged.employee_id)
  if (employee) {
    out.employee_name = employee.employee_name ?? merged.employee_name ?? null
    out.department = employee.department ?? null
    out.designation = employee.designation ?? null
    out.employment_type = employee.employment_type ?? merged.employment_type ?? null
    out.employee_email = merged.employee_email || employee.official_email || employee.personal_email || null
    out.employee_status = employee.employment_status || "Active"
    out.billing_role = merged.billing_role || employee.designation || null
  }

  // --- Centralized financial period (Phase 9). --------------------------------
  const period = fteFinancialPeriod(merged.invoice_date)
  out.financial_year = merged.financial_year || period.financial_year
  out.month = merged.month || period.month
  out.quarter = period.quarter
  out.accounting_period = period.accounting_period

  // --- Client billing / employee cost / margin (Phases 10–18). ----------------
  const billing = computeFteBilling({ ...merged, ...out })
  Object.assign(out, billing)

  // Payment + tax facets derived from the recomputed figures.
  out.payment_status = autoPaymentStatus(num(billing.net_receivable), num(merged.amount_paid), merged.payment_status)
  out.gst_status = num(merged.gst_rate) > 0 ? "Applicable" : "Not Applicable"
  out.tds_status = num(merged.tds_rate) > 0 ? "Applicable" : "Not Applicable"

  // --- Rate snapshot (Phase 15) — frozen once the invoice leaves Draft. --------
  const status = str(merged.status) || "Draft"
  const alreadyFrozen = num(merged.rate_snapshot) > 0
  if (status !== "Draft" && !alreadyFrozen) {
    out.rate_snapshot = round2(num(merged.billing_rate))
    out.billing_basis_snapshot = str(merged.billing_basis) || null
    out.rate_source = str(merged.rate_source) || "Manual / FTE Rate"
  }

  return out
}

// ---------------------------------------------------------------------------
// Hard validation (Phases 6, 19, 24). Sync — reads the snapshot fields the
// augment already wrote onto the merged record.
// ---------------------------------------------------------------------------

/** Normalize a party name for a tolerant client-vs-project comparison. */
function normName(v: any): string {
  return str(v).toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function validateFteInvoice(merged: Record<string, any>): string | null {
  // Required links.
  if (!str(merged.client_id).trim()) return "Select a client for this FTE invoice."
  if (!str(merged.employee_id).trim()) return "Select an employee for this FTE invoice."
  if (!str(merged.invoice_date).trim()) return "Invoice date is required."

  // Resource state (Phase 6/19). Snapshots are written by the server augment.
  if (merged.client_status && str(merged.client_status) !== "Active")
    return "The selected client is not active. Only active clients can be invoiced."
  if (merged.employee_status && str(merged.employee_status) !== "Active")
    return "The selected employee is not active. Only active employees can be billed."
  if (merged.project_id && merged.project_status && str(merged.project_status) !== "Active")
    return "The selected project is not active. Only active projects can be invoiced."

  // Relationship (Phase 4/6): the project must belong to the selected client.
  const projClient = normName(merged.project_client_name)
  const invClient = normName(merged.client_name)
  if (projClient && invClient && projClient !== invClient)
    return "This project belongs to a different client. Fix the client/project selection before invoicing."

  // Dates (Phase 19).
  const start = str(merged.billing_period_start).trim()
  const end = str(merged.billing_period_end).trim()
  if (start && end && new Date(end) < new Date(start))
    return "Billing period end cannot be before the billing period start."

  // Negative billing (Phase 19).
  if (num(merged.gross_client_billing) < 0) return "Gross client billing cannot be negative."
  if (num(merged.base_billing) < 0) return "Base billing cannot be negative."

  // Zero rate when a rate-driven basis requires one (Phase 19).
  const basis = str(merged.billing_basis)
  const rateDriven = ["Daily", "Working Days", "Hourly", "Monthly"].includes(basis)
  if (rateDriven && num(merged.billing_rate) <= 0 && num(merged.base_billing) <= 0)
    return `A billing rate is required for the "${basis}" billing basis.`

  // Contract window (Phase 24) — only when contract dates are supplied.
  const cStart = str(merged.contract_start).trim()
  const cEnd = str(merged.contract_end).trim()
  const invDate = str(merged.invoice_date).trim()
  if (invDate && cStart && new Date(invDate) < new Date(cStart))
    return "Invoice date falls before the linked contract start date."
  if (invDate && cEnd && new Date(invDate) > new Date(cEnd))
    return "Invoice date falls after the linked contract end date."

  return null
}

// ---------------------------------------------------------------------------
// Duplicate detection (Phase 20). Same client + project + employee + billing
// period (FY + month) already invoiced and not cancelled/reversed.
// ---------------------------------------------------------------------------

export async function findDuplicateFteInvoice(
  merged: Record<string, any>,
  excludeId: number | null,
): Promise<{ fte_invoice_id: string; reason: string } | null> {
  const clientId = str(merged.client_id).trim()
  const employeeId = str(merged.employee_id).trim()
  if (!clientId || !employeeId) return null

  const params: any[] = [clientId, employeeId, str(merged.project_id), str(merged.financial_year), str(merged.month)]
  let sql =
    `SELECT fte_invoice_id FROM fte_invoices
      WHERE client_id = ? AND employee_id = ?
        AND COALESCE(project_id,'') = ?
        AND COALESCE(financial_year,'') = ?
        AND COALESCE(month,'') = ?
        AND status NOT IN ('Cancelled','Reversed')`
  if (excludeId) {
    sql += " AND id <> ?"
    params.push(excludeId)
  }
  sql += " LIMIT 1"

  const rows = (await query(sql, params).catch(() => [] as any[])) as any[]
  if (rows[0]) {
    return {
      fte_invoice_id: rows[0].fte_invoice_id,
      reason: "The same employee, client and billing period is already invoiced.",
    }
  }
  return null
}
