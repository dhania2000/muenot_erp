import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { canActOnRecord } from "@/lib/permission-enforce"
import {
  createAdjustmentJournal,
  validateManualJournal,
  MANUAL_JOURNAL_ADJUSTMENT_KINDS,
  MANUAL_JOURNAL_SOURCE,
  type AdjustmentKind,
  type ManualJournalInput,
} from "@/lib/finance-journal"

export const runtime = "nodejs"

const PERMISSION_KEY = "finance.journal"

// ---------------------------------------------------------------------------
// SPEC 165 — Journal Reversal / Adjustment endpoint.
//
//   POST → raise a linked adjustment / correction / reclassification against a
//          POSTED journal. Nothing rewrites the original: the request creates a
//          NEW, approval-gated voucher (Draft, or Pending Approval with
//          { submit:true }) that carries a back-link to the original. A
//          "Correction" additionally reverses the original (a separate linked
//          JE-…-R voucher), because a correction asserts the original was wrong.
//
// Permission mapping mirrors the manual endpoint on the same catalog key:
// Adjustment and Reclassification layer a new balanced entry on top and need
// the "update" right; Correction unwinds posted ledger rows and therefore needs
// the stronger "delete" right, exactly like a reverse.
// ---------------------------------------------------------------------------

async function loadJournalRow(journalId: string) {
  const [row] = (await query(
    `SELECT id, created_by FROM journal_entries
      WHERE voucher_no = ? AND source_module = ? LIMIT 1`,
    [journalId, MANUAL_JOURNAL_SOURCE],
  )) as any[]
  return row ?? null
}

function readInput(body: Partial<ManualJournalInput>): ManualJournalInput {
  return {
    journalDate: String(body.journalDate ?? "").slice(0, 10),
    financialYear: body.financialYear ?? null,
    voucherType: body.voucherType ?? "Journal",
    referenceNo: body.referenceNo ?? null,
    narration: body.narration ?? null,
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

  const body = (await req.json().catch(() => ({}))) as Partial<ManualJournalInput> & {
    originalId?: string
    kind?: string
    submit?: boolean
  }

  const originalId = String(body.originalId ?? "").trim()
  const kind = body.kind as AdjustmentKind
  if (!originalId) return NextResponse.json({ error: "The original journal id is required." }, { status: 400 })
  if (!(MANUAL_JOURNAL_ADJUSTMENT_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Invalid adjustment kind." }, { status: 400 })
  }

  const row = await loadJournalRow(originalId)
  if (!row) {
    return NextResponse.json(
      { error: "This journal was not found, or it is a system posting that must be corrected through its source document." },
      { status: 404 },
    )
  }

  // Correction reverses the posted original → "delete" right; the additive
  // Adjustment / Reclassification only layer a new entry → "update" right.
  const requiredAction = kind === "Correction" ? "delete" : "update"
  if (!(await canActOnRecord(session, PERMISSION_KEY, requiredAction, row))) {
    const verb = kind === "Correction" ? "correct" : kind === "Reclassification" ? "reclassify" : "adjust"
    return NextResponse.json({ error: `You do not have permission to ${verb} this journal.` }, { status: 403 })
  }

  const input = readInput(body)
  const shapeError = validateManualJournal(input)
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 })

  try {
    const result = await createAdjustmentJournal(originalId, kind, input, {
      createdBy: session.userId,
      actorName: session.name ?? null,
      submit: !!body.submit,
    })
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (error) {
    const message = (error as Error)?.message || "Could not raise the adjustment."
    console.log("[v0] createAdjustmentJournal failed:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
