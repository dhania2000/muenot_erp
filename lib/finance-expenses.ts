import "server-only"
import { createHash } from "crypto"
import { pool, query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import { computeExpense, financialYearFor, accountingPeriodFor, num, round2 } from "@/lib/finance-calc"
import { resolveGstRate } from "@/lib/finance-masters"
import { resolveTdsRule, entityTypeForConstitution } from "@/lib/finance-tds-rules"
import { computeItcLedger } from "@/lib/finance-gst-input"

/**
 * Expenses server engine (Phases 1–34).
 *
 * Owns everything about an Expense that must never be trusted to the browser:
 *   - the immutable, server-generated, concurrency-safe Expense ID (Phase 2);
 *   - the authoritative Employee snapshot from HR → Employees (Phase 4);
 *   - the authoritative Vendor snapshot from Finance → Vendors (Phase 5);
 *   - the Project / Client / Cost-Centre linkage from Operations (Phase 6–8);
 *   - the Expense-Head → Chart-of-Accounts mapping (Phase 9);
 *   - the active Bank/Cash account snapshot (Phase 10);
 *   - the authoritative money recalculation (Phase 15);
 *   - hard validation (Phase 25) and duplicate detection (Phase 24).
 *
 * Masters are never duplicated — every snapshot is read live from the owning
 * module's table and frozen onto the expense row so a later master edit does
 * not rewrite historical documents.
 */

const FY_START_MONTH: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }

function fyStartYear(dateStr: string | null | undefined, startMonth: number): number {
  const d = dateStr ? new Date(dateStr) : new Date()
  const valid = !Number.isNaN(d.getTime()) ? d : new Date()
  const y = valid.getFullYear()
  return valid.getMonth() >= startMonth ? y : y - 1
}

/**
 * Generate the next Expense ID: `EXP-2026-000001` (Phase 2).
 *
 * Scoped to the financial year and drawn from the shared `record_id_sequences`
 * table inside a `FOR UPDATE` transaction, so it is unique, immutable and
 * concurrency-safe — never MAX+1, never reused.
 */
export async function nextExpenseId(expenseDate?: string | null): Promise<string> {
  const settings = await getSettings().catch(() => ({}) as Record<string, string>)
  const startMonth = FY_START_MONTH[settings["app.financial_year_start"] as string] ?? 3
  const year = fyStartYear(expenseDate, startMonth)
  const seqKey = `EXP${year}`

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
    return `EXP-${year}-${String(number).padStart(6, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

// Employee-borne / vendor-borne taxonomy lives in a shared, client-safe module
// so the form config and this engine can never drift apart.
export { EMPLOYEE_EXPENSE_TYPES, VENDOR_EXPENSE_TYPES } from "@/lib/finance-expense-types"
import { EMPLOYEE_EXPENSE_TYPES, VENDOR_EXPENSE_TYPES } from "@/lib/finance-expense-types"

function norm(v: any): string {
  return String(v ?? "").trim()
}
function isEmployeeType(t: any): boolean {
  return EMPLOYEE_EXPENSE_TYPES.includes(norm(t))
}
function isVendorType(t: any): boolean {
  return VENDOR_EXPENSE_TYPES.includes(norm(t))
}

async function loadEmployee(id?: string | null, name?: string | null) {
  if (norm(id)) {
    const rows = (await query(`SELECT * FROM hr_employees WHERE employee_id = ? LIMIT 1`, [norm(id)])) as any[]
    if (rows[0]) return rows[0]
  }
  if (norm(name)) {
    const rows = (await query(`SELECT * FROM hr_employees WHERE employee_name = ? LIMIT 1`, [norm(name)])) as any[]
    if (rows[0]) return rows[0]
  }
  return null
}

async function loadVendor(id?: string | null, name?: string | null) {
  if (norm(id)) {
    const rows = (await query(`SELECT * FROM customers_vendors WHERE party_id = ? LIMIT 1`, [norm(id)])) as any[]
    if (rows[0]) return rows[0]
  }
  if (norm(name)) {
    const rows = (await query(`SELECT * FROM customers_vendors WHERE customer_name = ? LIMIT 1`, [norm(name)])) as any[]
    if (rows[0]) return rows[0]
  }
  return null
}

async function loadProject(id?: string | null) {
  if (!norm(id)) return null
  const rows = (await query(`SELECT * FROM operations_projects WHERE project_id = ? LIMIT 1`, [norm(id)])) as any[]
  return rows[0] ?? null
}

async function loadAccount(id?: string | null, name?: string | null) {
  if (norm(id)) {
    const rows = (await query(`SELECT * FROM chart_of_accounts WHERE account_id = ? LIMIT 1`, [norm(id)])) as any[]
    if (rows[0]) return rows[0]
  }
  if (norm(name)) {
    const rows = (await query(`SELECT * FROM chart_of_accounts WHERE account_name = ? LIMIT 1`, [norm(name)])) as any[]
    if (rows[0]) return rows[0]
  }
  return null
}

async function loadBankAccount(id?: string | null) {
  if (!norm(id)) return null
  const rows = (await query(`SELECT * FROM finance_accounts WHERE finance_account_id = ? LIMIT 1`, [norm(id)])) as any[]
  return rows[0] ?? null
}

/** Payment modes that require a Bank/Cash account (Phase 10/25). */
const BANK_MODES = ["Bank Transfer", "UPI", "Cheque", "Credit Card", "Debit Card", "Card", "NEFT", "RTGS"]

/**
 * Resolve every master snapshot and recompute all server-owned money fields for
 * an Expense. Output is authoritative and overrides anything the browser sent.
 */
export async function computeExpenseServerFields(
  merged: Record<string, any>,
  opts: { isCreate: boolean },
): Promise<Record<string, any>> {
  const out: Record<string, any> = {}
  const type = norm(merged.expense_type)
  let vendorRow: Record<string, any> | null = null

  // Fill a snapshot field: always on create, only-blank on update so a posted
  // historical expense keeps its frozen values.
  const snap = (key: string, val: any) => {
    if (val === null || val === undefined || norm(val) === "") return
    if (opts.isCreate || merged[key] === undefined || merged[key] === null || norm(merged[key]) === "") {
      out[key] = val
    }
  }

  // --- Phase 4: employee snapshot (HR → Employees) ---------------------------
  if (isEmployeeType(type)) {
    const emp = await loadEmployee(merged.employee_id, merged.employee_name)
    if (emp) {
      out.employee_id = emp.employee_id
      out.employee_name = emp.employee_name
      snap("department", emp.department)
      snap("designation", emp.designation)
      snap("employment_type", emp.employment_type)
      snap("employee_email", emp.official_email)
      snap("employee_mobile", emp.mobile)
      snap("employee_manager", emp.reporting_manager)
    }
    // An employee expense is not a vendor expense — clear stray vendor id/name.
    out.vendor_id = null
    out.vendor_name = null
  }

  // --- Phase 5: vendor snapshot (Finance → Vendors) --------------------------
  if (isVendorType(type)) {
    const vendor = await loadVendor(merged.vendor_id, merged.vendor_name)
    vendorRow = vendor
    if (vendor) {
      out.vendor_id = vendor.party_id
      out.vendor_name = vendor.customer_name
      snap("vendor_legal_name", vendor.legal_name || vendor.trade_name || vendor.customer_name)
      snap("vendor_gstin", vendor.gstin)
      snap("gst_status", vendor.gst_verification_status)
      snap("gst_registration_type", vendor.gst_registration_type)
      snap("vendor_pan", norm(vendor.pan).toUpperCase())
      snap("vendor_state", vendor.state)
      snap("vendor_state_code", vendor.state_code)
      snap("vendor_pin", vendor.pin_code || vendor.postal_code)
      snap("vendor_address", vendor.registered_address || vendor.billing_address)
      snap("payment_terms", vendor.payment_terms_days)
      snap("currency", vendor.currency)
      // Inherit the vendor TDS profile when the expense hasn't set its own.
      if (opts.isCreate && merged.tds_section === undefined) snap("tds_section", vendor.tds_section)
      if (opts.isCreate && (merged.tds_rate === undefined || num(merged.tds_rate) === 0)) snap("tds_rate", vendor.tds_rate)
    }
    out.employee_id = null
    out.employee_name = null
  }

  // Unify the legacy generic party columns from whichever side is active so the
  // existing table, search and exports keep working.
  if (isEmployeeType(type)) {
    out.party_id = out.employee_id ?? merged.employee_id ?? null
    out.party_name = out.employee_name ?? merged.employee_name ?? merged.party_name ?? null
  } else if (isVendorType(type)) {
    out.party_id = out.vendor_id ?? merged.vendor_id ?? null
    out.party_name = out.vendor_name ?? merged.vendor_name ?? merged.party_name ?? null
  }

  // --- Phase 6/7/8: project / client / cost-centre (Operations) --------------
  const project = await loadProject(merged.project_id)
  if (project) {
    out.project_id = String(project.project_id)
    out.project_name = project.project_name
    snap("client_name", project.client_name)
    snap("project_status", project.status)
    if (opts.isCreate && norm(merged.department) === "") snap("department", project.service_vertical)
  }

  // --- Phase 9: expense head → Chart of Accounts -----------------------------
  const account = await loadAccount(merged.expense_head_account_id, merged.expense_head)
  if (account) {
    out.expense_head_account_id = account.account_id
    out.expense_head_account_name = account.account_name
    // Keep the human expense_head label in sync with the mapped COA name.
    if (norm(merged.expense_head) === "") out.expense_head = account.account_name
  }

  // --- Phase 10: bank/cash snapshot ------------------------------------------
  const bank = await loadBankAccount(merged.bank_cash_account_id)
  if (bank) {
    out.bank_cash_account_name = bank.account_name
  }

  // --- Phase 2: centralized GST rate resolution ------------------------------
  // The rate is NEVER hard-coded: when GST applies and the user has not typed an
  // explicit rate, resolve it from the central HSN/SAC + tax-slab master and
  // freeze which configuration applied (Phase 39 versioning).
  const gstApplicable = !!merged.gst_applicable
  let effectiveGstRate = num(merged.gst_rate)
  if (gstApplicable && effectiveGstRate <= 0) {
    const resolved = await resolveGstRate({ hsnSac: merged.hsn_sac, date: merged.expense_date })
    if (resolved) {
      effectiveGstRate = resolved.rate
      out.gst_rate = resolved.rate
      out.gst_rate_source = resolved.source
      out.gst_rule_version = resolved.version
      if (resolved.cess > 0 && num(merged.cess_amount) === 0) {
        out.cess_amount = round2((num(merged.taxable_amount) * resolved.cess) / 100)
      }
    }
  }

  // --- Phase 19–25: centralized TDS rule resolution --------------------------
  // Vendor expenses only (Phase 20 — never apply vendor TDS logic to employee
  // reimbursements). The rate comes from the effective-dated rule master; a
  // missing vendor PAN drops to the higher no-PAN rate (Phase 32). A rule's
  // single + cumulative thresholds gate whether TDS is deducted at all
  // (Phase 22). Every resolved rule is frozen onto the row (Phase 38/39).
  let tdsApplicable = !!merged.tds_applicable
  let effectiveTdsRate = num(merged.tds_rate)
  const tdsSection = norm(merged.tds_section)
  if (isVendorType(type) && tdsSection && (tdsApplicable || out.tds_section === undefined)) {
    const entityType = entityTypeForConstitution(vendorRow?.business_constitution ?? vendorRow?.constitution)
    const rule = await resolveTdsRule({ section: tdsSection, entityType, date: merged.expense_date })
    if (rule) {
      const hasPan = norm(out.vendor_pan ?? merged.vendor_pan).length >= 10
      const ruleRate = hasPan ? rule.rate : Math.max(rule.rate, rule.rate_no_pan)
      const base = num(merged.taxable_amount)

      // Cumulative FY spend for this vendor + section, excluding this row.
      const fy = financialYearFor(merged.expense_date)
      const [priorRow] = (await query(
        `SELECT COALESCE(SUM(taxable_amount),0) prior FROM expenses
           WHERE vendor_id = ? AND tds_section = ? AND financial_year = ?
             AND (? IS NULL OR expense_id <> ?)`,
        [out.vendor_id ?? merged.vendor_id ?? null, tdsSection, fy, merged.expense_id ?? null, merged.expense_id ?? null],
      )) as any[]
      const cumulative = num(priorRow?.prior) + base

      const overSingle = rule.threshold_single > 0 && base >= rule.threshold_single
      const overAnnual = rule.threshold_annual > 0 && cumulative >= rule.threshold_annual
      const noThreshold = rule.threshold_single === 0 && rule.threshold_annual === 0
      const crosses = noThreshold || overSingle || overAnnual

      tdsApplicable = crosses
      effectiveTdsRate = crosses ? ruleRate : 0
      out.tds_applicable = crosses ? 1 : 0
      out.tds_rate = effectiveTdsRate
      out.tds_section = rule.section
      out.tds_nature_of_payment = rule.nature_of_payment
      out.tds_entity_type = rule.entity_type
      out.tds_threshold_single = rule.threshold_single
      out.tds_threshold_annual = rule.threshold_annual
      out.tds_rule_version = rule.rule_version
      out.tds_no_pan_rate_applied = hasPan ? 0 : 1
    }
  }

  // --- Phase 15: authoritative money recalculation ---------------------------
  const money = computeExpense({
    ...merged,
    ...out,
    gst_rate: effectiveGstRate,
    tds_applicable: tdsApplicable,
    tds_rate: effectiveTdsRate,
  })
  Object.assign(out, money)
  out.tds_base = round2(num(out.taxable_amount))

  // --- Phase 5: reverse-charge (RCM) self-assessment -------------------------
  // On an RCM expense the recipient self-assesses the tax and (when creditable)
  // claims it back as ITC. Computed independently of the vendor-charged GST so
  // the two can never be double counted.
  if (merged.rcm_applicable) {
    const rcmBase = round2(num(merged.rcm_taxable_value) || num(out.taxable_amount))
    const interState = norm(merged.supply_type) === "Inter-State"
    const rcmCgst = interState ? 0 : round2((rcmBase * effectiveGstRate) / 2 / 100)
    const rcmSgst = interState ? 0 : round2((rcmBase * effectiveGstRate) / 2 / 100)
    const rcmIgst = interState ? round2((rcmBase * effectiveGstRate) / 100) : 0
    const rcmTotal = round2(rcmCgst + rcmSgst + rcmIgst)
    out.rcm_applicable = 1
    out.rcm_taxable_value = rcmBase
    out.rcm_cgst = rcmCgst
    out.rcm_sgst = rcmSgst
    out.rcm_igst = rcmIgst
    out.rcm_total = rcmTotal
    out.rcm_itc = merged.gst_credit_eligible ? rcmTotal : 0
  } else {
    out.rcm_applicable = 0
    out.rcm_taxable_value = 0
    out.rcm_cgst = 0
    out.rcm_sgst = 0
    out.rcm_igst = 0
    out.rcm_total = 0
    out.rcm_itc = 0
  }

  // --- Phase 6: ITC ledger (separately tracked, not auto-claimable) ----------
  // The input tax is the RCM self-assessed tax on an RCM expense, otherwise the
  // GST charged. Eligibility follows the expense's own credit flag, and an
  // optional reversal is netted off — mirroring the central GST Input engine.
  const itcEligible = !!merged.gst_credit_eligible
  const ledger = computeItcLedger({
    cgst: merged.rcm_applicable ? num(out.rcm_cgst) : num(out.cgst_amount),
    sgst: merged.rcm_applicable ? num(out.rcm_sgst) : num(out.sgst_amount),
    igst: merged.rcm_applicable ? num(out.rcm_igst) : num(out.igst_amount),
    cess: merged.rcm_applicable ? 0 : num(out.cess_amount),
    eligible: itcEligible,
    reversalAmount: num(merged.itc_reversal),
  })
  out.itc_cgst = ledger.cgst
  out.itc_sgst = ledger.sgst
  out.itc_igst = ledger.igst
  out.itc_cess = ledger.cess
  out.itc_total = ledger.eligible
  out.itc_reversal = ledger.reversal
  out.itc_net = ledger.net

  // ITC status mirrors the GST-credit eligibility flag (Phase 15/29).
  out.itc_status = ledger.gross === 0 ? "Not Applicable" : itcEligible ? "Eligible" : "Ineligible"

  // Financial year + accounting period are always derived server-side.
  out.financial_year = norm(merged.financial_year) || financialYearFor(merged.expense_date)
  out.accounting_period = norm(merged.accounting_period) || accountingPeriodFor(merged.expense_date)

  // Duplicate fingerprint (Phase 24).
  out.duplicate_hash = expenseHash({ ...merged, ...out })

  return out
}

/** Stable fingerprint used for duplicate detection (Phase 24). */
export function expenseHash(r: Record<string, any>): string {
  const parts = [
    norm(r.expense_type),
    norm(r.party_id) || norm(r.employee_id) || norm(r.vendor_id),
    norm(r.bill_receipt_no).toUpperCase(),
    norm(r.vendor_invoice_number).toUpperCase(),
    norm(r.expense_date),
    round2(num(r.gross_amount)).toFixed(2),
    norm(r.vendor_gstin).toUpperCase(),
  ]
  return createHash("sha256").update(parts.join("|")).digest("hex")
}

/**
 * Hard validation (Phase 25). Returns an error string when the record is
 * invalid, or null when it passes. Runs before the write on both POST and PATCH.
 */
export function validateExpense(merged: Record<string, any>): string | null {
  const type = norm(merged.expense_type)
  if (!type) return "Expense type is required"
  if (!norm(merged.expense_date)) return "Expense date is required"

  const d = new Date(merged.expense_date)
  if (Number.isNaN(d.getTime())) return "Expense date is invalid"

  if (isEmployeeType(type) && !norm(merged.employee_id) && !norm(merged.employee_name))
    return "Employee is required for an employee expense — select from HR → Employees"
  if (isVendorType(type) && !norm(merged.vendor_id) && !norm(merged.vendor_name))
    return "Vendor is required for a vendor expense — select from Finance → Vendors"

  const mode = norm(merged.payment_mode)
  if (BANK_MODES.includes(mode) && !norm(merged.bank_cash_account_id))
    return `A Bank/Cash account is required for payment mode "${mode}"`

  const taxable = num(merged.taxable_amount)
  const qtyRate = num(merged.quantity) * num(merged.rate)
  if (taxable <= 0 && qtyRate <= 0) return "Taxable amount must be greater than zero"

  return null
}

/**
 * Duplicate-expense guard (Phase 24). Warns when a very similar expense already
 * exists (same payee + amount + date, or a matching receipt / invoice number).
 * Returns the existing expense id or null.
 */
export async function findDuplicateExpense(
  merged: Record<string, any>,
  excludeId?: number | null,
): Promise<{ expense_id: string; reason: string } | null> {
  const hash = expenseHash(merged)
  const byHash = (await query(
    `SELECT expense_id FROM expenses WHERE duplicate_hash = ? AND (? IS NULL OR id <> ?) LIMIT 1`,
    [hash, excludeId ?? null, excludeId ?? null],
  )) as any[]
  if (byHash[0]) return { expense_id: byHash[0].expense_id, reason: "an identical expense fingerprint" }

  const receipt = norm(merged.bill_receipt_no)
  const invoice = norm(merged.vendor_invoice_number)
  const partyId = norm(merged.party_id) || norm(merged.employee_id) || norm(merged.vendor_id)
  if ((receipt || invoice) && partyId) {
    const byRef = (await query(
      `SELECT expense_id FROM expenses
         WHERE (party_id = ? OR employee_id = ? OR vendor_id = ?)
           AND ((? <> '' AND bill_receipt_no = ?) OR (? <> '' AND vendor_invoice_number = ?))
           AND (? IS NULL OR id <> ?)
         LIMIT 1`,
      [partyId, partyId, partyId, receipt, receipt, invoice, invoice, excludeId ?? null, excludeId ?? null],
    )) as any[]
    if (byRef[0]) return { expense_id: byRef[0].expense_id, reason: "the same receipt / invoice number for this payee" }
  }
  return null
}
