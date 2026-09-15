import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { canActOnRecord } from "@/lib/permission-enforce"
import { logFinanceEvent } from "@/lib/finance-audit"

export const runtime = "nodejs"

const PERMISSION_KEY = "finance.journal"

// ---------------------------------------------------------------------------
// GL reconciliation action (Phases 56–58).
//
// The General Ledger stays read-only for accounting *values* — every debit /
// credit is owned by its Journal Entry. The one operational flag a reviewer may
// flip directly on a posted row is its reconciliation state (matching a posting
// against a bank statement / source). This endpoint is the only writer of that
// flag, and it never touches amounts, accounts, or the journal link.
//
// RBAC reuses the existing finance.journal "update" right (a user who may work
// journals may reconcile their postings). Reconcile is guarded with an
// optimistic concurrency check: the caller sends the status it believes the row
// is in, and the UPDATE only succeeds if the row is still in that status — so
// two reviewers acting on the same stale row can't silently clobber each other.
// ---------------------------------------------------------------------------

const RECONCILABLE_STATUSES = new Set(["Reconciled", "Unreconciled"])
const norm = (v: unknown) => {
  const s = String(v ?? "").trim()
  return s === "" ? "Unreconciled" : s
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    ledger_id?: string
    status?: string
    expected_status?: string
  }

  const ledgerId = String(body.ledger_id ?? "").trim()
  const status = norm(body.status)
  if (!ledgerId) return NextResponse.json({ error: "A ledger id is required." }, { status: 400 })
  if (!RECONCILABLE_STATUSES.has(status)) {
    return NextResponse.json({ error: "Reconciliation status must be Reconciled or Unreconciled." }, { status: 400 })
  }

  // Load the current row so we can (a) scope the permission check to its owner
  // and (b) run the optimistic concurrency check against its live status.
  const [row] = (await query(
    `SELECT id, ledger_id, voucher_no, journal_entry_id, account_name, party_name,
            created_by, COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS reconciliation_status
       FROM general_ledger WHERE ledger_id = ? LIMIT 1`,
    [ledgerId],
  )) as any[]
  if (!row) return NextResponse.json({ error: "This ledger entry was not found." }, { status: 404 })

  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", row))) {
    return NextResponse.json({ error: "You do not have permission to reconcile this entry." }, { status: 403 })
  }

  const current = norm(row.reconciliation_status)
  if (current === status) {
    return NextResponse.json({ ok: true, ledger_id: ledgerId, status, unchanged: true })
  }

  // Optimistic concurrency: only flip the row if it is still in the status the
  // caller last saw. A mismatch means someone else moved it first.
  const expected = body.expected_status != null ? norm(body.expected_status) : current
  const reconciledAt = status === "Reconciled" ? new Date() : null

  const result = (await query(
    `UPDATE general_ledger
        SET reconciliation_status = ?, reconciliation_date = ?
      WHERE ledger_id = ?
        AND COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') = ?`,
    [status, reconciledAt, ledgerId, expected],
  )) as any

  const affected = Number(result?.affectedRows ?? 0)
  if (affected === 0) {
    return NextResponse.json(
      {
        error: "This entry was changed by someone else. Refresh and try again.",
        conflict: true,
        current,
      },
      { status: 409 },
    )
  }

  await logFinanceEvent({
    entityType: "general_ledger",
    entityPk: Number(row.id),
    entityRef: ledgerId,
    voucherNo: String(row.voucher_no || row.journal_entry_id || ""),
    type: "updated",
    summary:
      status === "Reconciled"
        ? `Ledger ${ledgerId} marked Reconciled`
        : `Ledger ${ledgerId} marked Unreconciled`,
    detail: { from: current, to: status, field: "reconciliation_status" },
    actorId: session.userId,
    actorName: session.name ?? null,
  }).catch(() => {})

  return NextResponse.json({ ok: true, ledger_id: ledgerId, status })
}
