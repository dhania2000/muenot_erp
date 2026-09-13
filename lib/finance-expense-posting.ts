import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { postLines, type PostingResult } from "@/lib/finance-posting"
import { ensureExpensePostingAccounts } from "@/lib/finance-accounts"

/**
 * Expense accounting — double-entry posting on the accrual-on-post model.
 *
 * When an expense reaches an approved/posted state we recognise the expense and
 * the liability up front (accrual); paying it later only clears the payable
 * (see finance-expense-payments). Nothing here computes money — every figure is
 * read from the stored, server-authoritative expense row (computeExpense). The
 * balanced voucher is:
 *
 *   Dr  Expense head            taxable + non-creditable GST
 *   Dr  Input CGST/SGST/IGST    creditable GST (ITC), only when GST-credit eligible
 *   Dr  Input Cess              creditable cess
 *       Cr  TDS Payable         tds withheld
 *       Cr  <party> Payable     gross − tds   (employee reimbursement or vendor AP)
 *
 * Debit total = taxable + total GST + cess = gross; credit total = tds + (gross
 * − tds) = gross, so the voucher always balances. The expense head prefers the
 * row's own Chart-of-Accounts mapping (`expense_head_account_id`); it falls back
 * to the generic `expense` role only when no head was mapped.
 *
 * This mirrors syncPurchaseBillPosting: keyed off `voucher_no` + `posted_gross`
 * so it never double-posts, re-posts cleanly when the amount changes, and
 * reverses when the expense leaves a postable state.
 */

/** Workflow states that own an active accounting posting (accrual recognised). */
const POSTABLE_WORKFLOW = new Set(["Approved", "Posted", "Paid", "Partially Paid"])

/** Return true when the expense row is in a state that should be posted. */
function isPostable(exp: Record<string, any>): boolean {
  const wf = String(exp.workflow_status || "").trim()
  if (wf) return POSTABLE_WORKFLOW.has(wf)
  // Legacy rows with no workflow_status fall back to the coarse approval flag.
  return String(exp.approval_status || "").trim() === "Approved"
}

/** Party payable role — employee reimbursements vs vendor accounts payable. */
function payableRole(exp: Record<string, any>): "employee_payable" | "vendor_payable" {
  return exp.employee_id || exp.employee_name ? "employee_payable" : "vendor_payable"
}

/** Build the balanced posting lines for an expense from its stored totals. */
export function buildExpenseLines(exp: Record<string, any>) {
  const taxable = round2(num(exp.taxable_amount))
  const cgst = round2(num(exp.cgst_amount))
  const sgst = round2(num(exp.sgst_amount))
  const igst = round2(num(exp.igst_amount))
  const cess = round2(num(exp.cess_amount))
  const tds = round2(num(exp.tds_amount))
  const gstTotal = round2(cgst + sgst + igst + cess)
  const gross = round2(taxable + gstTotal)

  // GST is creditable (ITC) only when the row is flagged GST-credit eligible.
  // When it is not, the tax is a cost and rolls into the expense head.
  const creditable = !!exp.gst_credit_eligible && !!exp.gst_applicable
  const itcCgst = creditable ? cgst : 0
  const itcSgst = creditable ? sgst : 0
  const itcIgst = creditable ? igst : 0
  const itcCess = creditable ? cess : 0
  const nonCreditableGst = round2(gstTotal - (itcCgst + itcSgst + itcIgst + itcCess))

  const expenseDebit = round2(taxable + nonCreditableGst)
  const payable = round2(gross - tds)

  const lines: Array<{
    role: "expense" | "input_cgst" | "input_sgst" | "input_igst" | "input_cess" | "tds_payable" | "employee_payable" | "vendor_payable"
    debit: number
    credit: number
    gst?: number
    tds?: number
    accountId?: string | null
  }> = []

  if (expenseDebit > 0) {
    lines.push({
      role: "expense",
      debit: expenseDebit,
      credit: 0,
      gst: nonCreditableGst || undefined,
      // Post to the expense's own mapped Chart-of-Accounts head when present.
      accountId: exp.expense_head_account_id ? String(exp.expense_head_account_id) : null,
    })
  }
  if (itcCgst > 0) lines.push({ role: "input_cgst", debit: itcCgst, credit: 0, gst: itcCgst })
  if (itcSgst > 0) lines.push({ role: "input_sgst", debit: itcSgst, credit: 0, gst: itcSgst })
  if (itcIgst > 0) lines.push({ role: "input_igst", debit: itcIgst, credit: 0, gst: itcIgst })
  if (itcCess > 0) lines.push({ role: "input_cess", debit: itcCess, credit: 0, gst: itcCess })
  if (tds > 0) lines.push({ role: "tds_payable", debit: 0, credit: tds, tds })
  if (payable > 0) lines.push({ role: payableRole(exp), debit: 0, credit: payable })

  return lines
}

/** Post (or reverse) an expense from its stored, server-authoritative totals. */
export async function postExpense(
  exp: Record<string, any>,
  opts: { createdBy?: number | null; reverse?: boolean } = {},
): Promise<PostingResult> {
  await ensureExpensePostingAccounts()
  const lines = buildExpenseLines(exp)
  const ref = String(exp.expense_id || exp.id)
  return postLines(lines, {
    entityType: "expense",
    entityId: Number(exp.id),
    entityRef: ref,
    date: String(exp.expense_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    financialYear: exp.financial_year ?? null,
    partyId: exp.employee_id || exp.vendor_id || null,
    partyName: exp.employee_name || exp.vendor_name || exp.party_name || null,
    projectId: exp.project_id || null,
    projectName: exp.project_name || null,
    voucherType: "Journal",
    narration: opts.reverse
      ? `Reversal of expense ${ref}`
      : `Expense ${ref}${exp.expense_head ? ` — ${exp.expense_head}` : ""}`,
    sourceModule: "Expense",
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

const snapshotOf = (e: Record<string, any>) => ({
  id: e.id,
  expense_id: e.expense_id,
  expense_date: e.expense_date,
  financial_year: e.financial_year,
  employee_id: e.employee_id,
  employee_name: e.employee_name,
  vendor_id: e.vendor_id,
  vendor_name: e.vendor_name,
  party_name: e.party_name,
  project_id: e.project_id,
  project_name: e.project_name,
  expense_head: e.expense_head,
  expense_head_account_id: e.expense_head_account_id,
  gst_applicable: e.gst_applicable,
  gst_credit_eligible: e.gst_credit_eligible,
  taxable_amount: num(e.taxable_amount),
  cgst_amount: num(e.cgst_amount),
  sgst_amount: num(e.sgst_amount),
  igst_amount: num(e.igst_amount),
  cess_amount: num(e.cess_amount),
  tds_amount: num(e.tds_amount),
})

/**
 * Idempotently keep an expense's Journal + General Ledger posting in sync with
 * its stored totals and workflow state. Same contract as syncPurchaseBillPosting:
 *   - not postable (draft/submitted/pending/rejected/cancelled, or zero gross)
 *     → reverse any existing voucher and clear the posting columns;
 *   - already posted with the same gross → no-op;
 *   - posted with a changed gross → reverse then re-post;
 *   - postable and not yet posted → post and stamp the voucher onto the row.
 *
 * Failures are swallowed and left as `Unposted` so a transient posting error
 * never blocks expense CRUD; the next save re-attempts.
 */
export async function syncExpensePosting(
  expenseId: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ action: "posted" | "reposted" | "reversed" | "skipped" | "error"; voucherNo?: string }> {
  const [exp] = (await query(`SELECT * FROM expenses WHERE expense_id = ? LIMIT 1`, [expenseId])) as any[]
  if (!exp) return { action: "skipped" }

  const gross = round2(
    num(exp.gross_amount) ||
      num(exp.taxable_amount) + num(exp.cgst_amount) + num(exp.sgst_amount) + num(exp.igst_amount) + num(exp.cess_amount),
  )
  const existingVoucher = exp.voucher_no ? String(exp.voucher_no) : null
  const postedGross = round2(num(exp.posted_gross))

  // Reversal must unwind the amounts exactly as posted, not the current row.
  let postedSnapshot: Record<string, any> = exp
  if (exp.posted_snapshot) {
    try {
      postedSnapshot = { ...JSON.parse(String(exp.posted_snapshot)), id: exp.id, expense_id: exp.expense_id }
    } catch {
      postedSnapshot = exp
    }
  }

  const reverseExisting = async () => {
    if (!existingVoucher) return
    await postExpense(postedSnapshot, { createdBy: opts.createdBy ?? null, reverse: true })
    await query(
      `UPDATE expenses
          SET reversal_voucher_no = ?, voucher_no = NULL, posting_status = 'Unposted', posted_gross = 0, posted_snapshot = NULL
        WHERE id = ?`,
      [existingVoucher, exp.id],
    )
  }

  try {
    if (gross <= 0 || !isPostable(exp)) {
      if (existingVoucher) {
        await reverseExisting()
        return { action: "reversed" }
      }
      return { action: "skipped" }
    }

    if (existingVoucher && Math.abs(postedGross - gross) <= 0.01) {
      return { action: "skipped", voucherNo: existingVoucher }
    }

    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postExpense(exp, { createdBy: opts.createdBy ?? null })
    await query(
      `UPDATE expenses
          SET voucher_no = ?, posting_status = 'Posted', posted_at = NOW(), posted_gross = ?, posted_snapshot = ?
        WHERE id = ?`,
      [result.voucherNo, gross, JSON.stringify(snapshotOf(exp)), exp.id],
    )
    return { action: reposted ? "reposted" : "posted", voucherNo: result.voucherNo }
  } catch (error) {
    console.log("[v0] expense posting failed for", expenseId, (error as Error)?.message)
    await query(`UPDATE expenses SET posting_status = 'Unposted' WHERE id = ?`, [exp.id]).catch(() => {})
    return { action: "error" }
  }
}

/** Unconditionally reverse an expense's posting (used on delete). */
export async function reverseExpensePosting(
  expenseId: string,
  opts: { createdBy?: number | null } = {},
): Promise<void> {
  const [exp] = (await query(`SELECT * FROM expenses WHERE expense_id = ? LIMIT 1`, [expenseId])) as any[]
  if (!exp || !exp.voucher_no) return
  let snapshot: Record<string, any> = exp
  if (exp.posted_snapshot) {
    try {
      snapshot = { ...JSON.parse(String(exp.posted_snapshot)), id: exp.id, expense_id: exp.expense_id }
    } catch {
      snapshot = exp
    }
  }
  try {
    await postExpense(snapshot, { createdBy: opts.createdBy ?? null, reverse: true })
    await query(
      `UPDATE expenses
          SET reversal_voucher_no = voucher_no, voucher_no = NULL, posting_status = 'Unposted', posted_gross = 0, posted_snapshot = NULL
        WHERE id = ?`,
      [exp.id],
    )
  } catch (error) {
    console.log("[v0] expense reversal failed for", expenseId, (error as Error)?.message)
  }
}
