import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { canCreateInModule, canActOnRecord } from "@/lib/permission-enforce"
import {
  listPostableAccounts,
  postManualJournal,
  deleteManualJournal,
  validateManualJournal,
  MANUAL_JOURNAL_SOURCE,
  type ManualJournalInput,
} from "@/lib/finance-journal"

const PERMISSION_KEY = "finance.journal"

// ---------------------------------------------------------------------------
// Manual journal endpoint. Separate from the generic config-driven module CRUD
// because a manual journal is a multi-line, balanced voucher that posts to the
// ledger as a group — not a single editable row.
//
//   GET    → active Chart-of-Accounts heads for the line picker
//   POST   → validate + post a balanced manual journal (immediate to GL)
//   DELETE → remove a manual journal group and unwind it from the ledger
// ---------------------------------------------------------------------------

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const accounts = await listPostableAccounts()
  return NextResponse.json({ accounts })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to create journal entries." }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as Partial<ManualJournalInput>
  const input: ManualJournalInput = {
    journalDate: String(body.journalDate ?? "").slice(0, 10),
    financialYear: body.financialYear ?? null,
    voucherType: body.voucherType ?? "Journal",
    referenceNo: body.referenceNo ?? null,
    narration: body.narration ?? null,
    lines: Array.isArray(body.lines) ? body.lines : [],
  }

  const shapeError = validateManualJournal(input)
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 })

  try {
    const result = await postManualJournal(input, { createdBy: session.userId })
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (error) {
    const message = (error as Error)?.message || "Could not post the journal."
    console.log("[v0] postManualJournal failed:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const journalId = req.nextUrl.searchParams.get("journal_id")
  if (!journalId) return NextResponse.json({ error: "A journal id is required." }, { status: 400 })

  // Only a manual voucher is removable here, and only by a user allowed to
  // delete in the journal area. Load one line to scope the permission check.
  const [row] = (await query(
    `SELECT id, created_by FROM journal_entries
      WHERE voucher_no = ? AND source_module = ? LIMIT 1`,
    [journalId, MANUAL_JOURNAL_SOURCE],
  )) as any[]
  if (!row) {
    return NextResponse.json(
      { error: "This journal was not found, or it is a system posting that must be reversed through its source document." },
      { status: 404 },
    )
  }
  if (!(await canActOnRecord(session, PERMISSION_KEY, "delete", row))) {
    return NextResponse.json({ error: "You do not have permission to delete this journal." }, { status: 403 })
  }

  try {
    const { removed } = await deleteManualJournal(journalId)
    return NextResponse.json({ ok: true, removed })
  } catch (error) {
    const message = (error as Error)?.message || "Could not delete the journal."
    console.log("[v0] deleteManualJournal failed:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
