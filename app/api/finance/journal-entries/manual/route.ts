import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { canCreateInModule, canActOnRecord } from "@/lib/permission-enforce"
import { getFinanceEventsByRefs } from "@/lib/finance-audit"
import {
  listPostableAccounts,
  createManualJournal,
  updateManualJournalDraft,
  transitionManualJournal,
  deleteManualJournal,
  getManualJournal,
  listJournalAdjustments,
  validateManualJournal,
  JOURNAL_ACTIONS,
  MANUAL_JOURNAL_SOURCE,
  type ManualJournalInput,
  type JournalAction,
} from "@/lib/finance-journal"

export const runtime = "nodejs"

const PERMISSION_KEY = "finance.journal"

// ---------------------------------------------------------------------------
// Manual journal endpoint — the central accounting workflow. Separate from the
// generic config-driven module CRUD because a manual journal is a multi-line,
// balanced voucher that moves through an approval lifecycle as a GROUP.
//
//   GET    → active Chart-of-Accounts heads for the line picker; with
//            ?journal_id= returns one journal group (header + lines) for edit.
//   POST   → create a Draft (or, with { submit:true }, a Pending Approval)
//            journal. Nothing posts to the ledger yet.
//   PUT    → replace the lines of an editable (unposted) journal.
//   PATCH  → run a workflow action { action: submit|approve|reject|cancel|
//            post|reverse }. Posting/reversal touch the general ledger.
//   DELETE → remove an unposted manual journal group.
//
// Permission mapping reuses the existing finance permissions on this catalog
// key: creating/submitting needs "add"; approving, rejecting, posting,
// cancelling and editing need "update"; reversing and deleting need "delete".
// A user with only "add" can draft and submit but can never approve or post.
// ---------------------------------------------------------------------------

/** Actions that require the "update" right vs the stronger "delete" right. */
const DELETE_ACTIONS = new Set<JournalAction>(["reverse"])

/** Load one line of a manual journal so a permission check can be row-scoped. */
async function loadJournalRow(journalId: string) {
  const [row] = (await query(
    `SELECT id, created_by FROM journal_entries
      WHERE voucher_no = ? AND source_module = ? LIMIT 1`,
    [journalId, MANUAL_JOURNAL_SOURCE],
  )) as any[]
  return row ?? null
}

const notFound = () =>
  NextResponse.json(
    { error: "This journal was not found, or it is a system posting that must be reversed through its source document." },
    { status: 404 },
  )

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const journalId = req.nextUrl.searchParams.get("journal_id")
  if (journalId) {
    const { status, rows } = await getManualJournal(journalId)
    if (!rows.length) return notFound()
    // Phase 42/47 — the detail drawer shows the full lifecycle trail alongside
    // the header + lines. Manual-journal events are keyed by the voucher ref.
    const events = await getFinanceEventsByRefs("journal", [journalId])
    // SPEC 165 — every adjustment/correction/reclassification raised against
    // this voucher, so the drawer can show the chain of corrections layered on.
    const links = await listJournalAdjustments(journalId)
    return NextResponse.json({ status, rows, events, links })
  }

  const accounts = await listPostableAccounts()
  return NextResponse.json({ accounts })
}

function readInput(body: Partial<ManualJournalInput>): ManualJournalInput {
  return {
    journalDate: String(body.journalDate ?? "").slice(0, 10),
    financialYear: body.financialYear ?? null,
    voucherType: body.voucherType ?? "Journal",
    referenceNo: body.referenceNo ?? null,
    narration: body.narration ?? null,
    // Phase 36/37 — header-level payment + attachment metadata.
    paymentMode: body.paymentMode ?? null,
    chequeUtrReference: body.chequeUtrReference ?? null,
    attachmentUrl: body.attachmentUrl ?? null,
    attachmentType: body.attachmentType ?? null,
    lines: Array.isArray(body.lines) ? body.lines : [],
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to create journal entries." }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as Partial<ManualJournalInput> & { submit?: boolean }
  const input = readInput(body)

  const shapeError = validateManualJournal(input)
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 })

  try {
    const result = await createManualJournal(input, {
      createdBy: session.userId,
      actorName: session.name ?? null,
      submit: !!body.submit,
    })
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (error) {
    const message = (error as Error)?.message || "Could not save the journal."
    console.log("[v0] createManualJournal failed:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function PUT(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Partial<ManualJournalInput> & { journalId?: string }
  const journalId = String(body.journalId ?? "").trim()
  if (!journalId) return NextResponse.json({ error: "A journal id is required." }, { status: 400 })

  const row = await loadJournalRow(journalId)
  if (!row) return notFound()
  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", row))) {
    return NextResponse.json({ error: "You do not have permission to edit this journal." }, { status: 403 })
  }

  const input = readInput(body)
  const shapeError = validateManualJournal(input)
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 })

  try {
    const result = await updateManualJournalDraft(journalId, input, {
      userId: session.userId,
      actorName: session.name ?? null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = (error as Error)?.message || "Could not update the journal."
    console.log("[v0] updateManualJournalDraft failed:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { journalId?: string; action?: string; reason?: string }
  const journalId = String(body.journalId ?? "").trim()
  const action = body.action as JournalAction
  const reason = typeof body.reason === "string" ? body.reason : null

  if (!journalId) return NextResponse.json({ error: "A journal id is required." }, { status: 400 })
  if (!JOURNAL_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "Invalid workflow action." }, { status: 400 })
  }

  const row = await loadJournalRow(journalId)
  if (!row) return notFound()

  // Reversing unwinds posted ledger rows, so it needs the stronger "delete"
  // right; every other transition (submit/approve/reject/cancel/post) needs
  // "update". A creator with only "add" therefore cannot approve or post.
  const requiredAction = DELETE_ACTIONS.has(action) ? "delete" : "update"
  if (!(await canActOnRecord(session, PERMISSION_KEY, requiredAction, row))) {
    return NextResponse.json({ error: `You do not have permission to ${action} this journal.` }, { status: 403 })
  }

  try {
    const result = await transitionManualJournal(journalId, action, {
      userId: session.userId,
      actorName: session.name ?? null,
      reason,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = (error as Error)?.message || "Could not update the journal."
    console.log("[v0] transitionManualJournal failed:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const journalId = req.nextUrl.searchParams.get("journal_id")
  if (!journalId) return NextResponse.json({ error: "A journal id is required." }, { status: 400 })

  const row = await loadJournalRow(journalId)
  if (!row) return notFound()
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
