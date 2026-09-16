import "server-only"
import { query, tableColumns } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { ensureExpenseColumns } from "@/lib/finance-ensure"
import { computeExpenseServerFields, nextExpenseId } from "@/lib/finance-expenses"

/**
 * Recruitment Cost → Finance Expense sync (Phases 47/48/50).
 *
 * The Recruitment Cost module owns *what* was spent to hire (agency fee, job
 * portal, advertising, BGV, interview, referral, ...). It must NOT keep its own
 * accounting ledger — the single source of truth for money is Finance. So every
 * recruitment cost with a real spend is mirrored into the one `expenses` table
 * through the same server engine (`computeExpenseServerFields`) the manual
 * expense form uses, and the generated Finance Expense ID is written back onto
 * the cost row so the two stay linked (no duplicate accounting engine).
 *
 * Design rules:
 *  - Idempotent: one Finance Expense per recruitment cost, matched on
 *    (source_module, source_ref = cost_id). Re-saving a cost updates the same
 *    expense instead of creating a second one.
 *  - Non-destructive: the mirrored expense is created as "Pending", so GL
 *    posting stays under Finance's own approval workflow — recruitment never
 *    force-posts to the ledger.
 *  - Failure-tolerant: the caller wraps this in try/catch; a sync error must
 *    never block recruitment cost CRUD.
 */

const SOURCE_MODULE = "recruitment_costs"

/** Cost categories that describe a vendor-billed service vs. an internal cost. */
function expenseTypeFor(cost: Record<string, any>): string {
  const vendor = String(cost.vendor_name ?? cost.vendor_id ?? "").trim()
  // A named vendor → a proper Vendor Expense (drives the vendor snapshot);
  // otherwise a generic Business Expense (still vendor-borne, no vendor needed).
  return vendor ? "Vendor Expense" : "Business Expense"
}

function expenseDescriptionFor(cost: Record<string, any>, costId: string): string {
  const bits = [
    cost.description ? String(cost.description) : `Recruitment cost ${costId}`,
    cost.job_title ? `Job: ${cost.job_title}` : null,
    cost.requisition_id ? `Requisition: ${cost.requisition_id}` : null,
  ].filter(Boolean)
  return bits.join(" · ")
}

let sourceColumnsEnsured = false
async function ensureExpenseSourceColumns(): Promise<void> {
  if (sourceColumnsEnsured) return
  const cols = await tableColumns("expenses")
  if (!cols.has("source_module")) {
    await query(`ALTER TABLE expenses ADD COLUMN source_module VARCHAR(60) DEFAULT NULL`).catch(() => {})
  }
  if (!cols.has("source_ref")) {
    await query(`ALTER TABLE expenses ADD COLUMN source_ref VARCHAR(80) DEFAULT NULL`).catch(() => {})
  }
  await query(
    `ALTER TABLE expenses ADD INDEX idx_expenses_source (source_module, source_ref)`,
  ).catch(() => {})
  sourceColumnsEnsured = true
}

/**
 * Create or update the Finance Expense that mirrors a recruitment cost, and
 * write the resulting Expense ID back onto the cost row. No-ops when there is
 * no cost id or no actual spend to account for yet.
 */
export async function syncRecruitmentCostToExpense(
  cost: Record<string, any>,
  userId: number,
): Promise<{ expenseId: string; created: boolean } | null> {
  const costId = String(cost.cost_id ?? "").trim()
  if (!costId) return null

  // Only real, incurred spend flows to Finance. A pure budget line (actual = 0)
  // is a planning figure for the hiring-budget view (Phase 49), not a ledger
  // entry, so it must not create an expense.
  const actual = round2(num(cost.actual_amount))
  if (actual <= 0) return null

  await ensureExpenseColumns()
  await ensureExpenseSourceColumns()

  const existingRows = (await query(
    `SELECT * FROM expenses WHERE source_module = ? AND source_ref = ? LIMIT 1`,
    [SOURCE_MODULE, costId],
  )) as any[]
  const existing = existingRows[0] ?? null

  const expenseDate =
    (cost.cost_date && String(cost.cost_date)) ||
    (existing?.expense_date && String(existing.expense_date)) ||
    new Date().toISOString().slice(0, 10)

  const base: Record<string, any> = {
    ...(existing ?? {}),
    expense_type: expenseTypeFor(cost),
    expense_date: expenseDate,
    expense_category: cost.cost_category ? `Recruitment — ${cost.cost_category}` : "Recruitment",
    description: expenseDescriptionFor(cost, costId),
    reference_number: costId,
    vendor_id: cost.vendor_id ?? existing?.vendor_id ?? null,
    vendor_name: cost.vendor_name ?? existing?.vendor_name ?? null,
    quantity: 1,
    rate: actual,
    taxable_amount: actual,
    // Leave GL posting to Finance's approval workflow — never auto-post.
    approval_status: existing?.approval_status || "Pending",
    source_module: SOURCE_MODULE,
    source_ref: costId,
  }

  const isCreate = !existing
  const computed = await computeExpenseServerFields(base, { isCreate })
  const merged: Record<string, any> = { ...base, ...computed }

  const cols = await tableColumns("expenses")
  let expenseId = existing?.expense_id ? String(existing.expense_id) : ""

  if (existing) {
    const updatable = Object.keys(merged).filter(
      (k) => cols.has(k) && k !== "id" && k !== "expense_id",
    )
    if (updatable.length) {
      await query(
        `UPDATE expenses SET ${updatable.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
        [...updatable.map((c) => merged[c]), existing.id],
      )
    }
  } else {
    expenseId = await nextExpenseId(expenseDate)
    merged.expense_id = expenseId
    if (cols.has("created_by")) merged.created_by = userId
    const insertable = Object.keys(merged).filter((k) => cols.has(k) && k !== "id")
    await query(
      `INSERT INTO expenses (${insertable.join(",")}) VALUES (${insertable.map(() => "?").join(",")})`,
      insertable.map((c) => merged[c]),
    )
  }

  // Link the cost back to its Finance Expense (Phase 48/50). Best-effort — the
  // cost row is already committed by the caller; this only annotates it.
  if (expenseId) {
    await query(`UPDATE recruitment_costs SET expense_id = ? WHERE cost_id = ?`, [expenseId, costId]).catch(
      () => {},
    )
  }

  return { expenseId, created: isCreate }
}
