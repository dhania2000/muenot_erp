import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLetterTables } from "@/lib/hr-letters-db"
import { fileLetterToDocuments, getLetter } from "@/lib/hr-letters-generate"
import { getLetterEvents, logLetterEvent } from "@/lib/hr-letters-audit"
import { LETTER_STATUSES, type LetterStatus } from "@/lib/hr-letters-shared"

// Single generated letter: detail (with version lineage + audit), status change, cancel.

const FEATURE = "hr.view_letters"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, FEATURE))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id } = await params
  const letter = await getLetter(Number(id))
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 })

  // Version lineage: every letter that shares this document's supersede chain.
  const versions = await query<any[]>(
    `SELECT id, letter_number, status, template_version, created_at, supersedes_id, superseded_by
       FROM hr_letters
      WHERE id = ? OR supersedes_id = ? OR superseded_by = ? OR id = ?
      ORDER BY created_at ASC, id ASC`,
    [letter.id, letter.id, letter.id, letter.supersedes_id ?? 0],
  )
  const events = await getLetterEvents(letter.id)
  return NextResponse.json({ letter, versions, events })
}

const TIMESTAMP_FOR: Partial<Record<LetterStatus, string>> = {
  Issued: "issued_at",
  Delivered: "delivered_at",
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, FEATURE))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await ensureLetterTables()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const to = String(body.status || "").trim() as LetterStatus
  if (!LETTER_STATUSES.includes(to)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 })
  }

  const rows = await query<any[]>(
    "SELECT id, letter_number, status FROM hr_letters WHERE id = ? LIMIT 1",
    [id],
  )
  const current = rows[0]
  if (!current) return NextResponse.json({ error: "Letter not found" }, { status: 404 })
  if (current.status === "Cancelled") {
    return NextResponse.json({ error: "A cancelled letter cannot change status" }, { status: 422 })
  }

  const stampCol = TIMESTAMP_FOR[to]
  const stampSql = stampCol ? `, ${stampCol} = COALESCE(${stampCol}, NOW())` : ""
  await query(`UPDATE hr_letters SET status = ?${stampSql} WHERE id = ?`, [to, id])

  await logLetterEvent({
    letterId: Number(id),
    letterNumber: current.letter_number,
    type: to === "Issued" ? "issued" : to === "Delivered" ? "delivered" : "status_changed",
    summary: `Status changed ${current.status} → ${to}`,
    detail: { from: current.status, to },
    actorId: session.userId,
    actorName: session.name ?? null,
  })

  // Once a letter is issued or delivered it becomes part of the employee's
  // permanent record — file the PDF into the document vault (idempotent).
  if (to === "Issued" || to === "Delivered") {
    await fileLetterToDocuments(Number(id), session.userId)
  }

  const letter = await getLetter(Number(id))
  return NextResponse.json({ letter })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, FEATURE))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await ensureLetterTables()
  const { id } = await params

  // A cancellation reason may arrive as a query param or JSON body.
  const body = await request.json().catch(() => ({}))
  const reason = String(
    body?.reason ?? new URL(request.url).searchParams.get("reason") ?? "",
  ).trim()

  // Soft cancel keeps the audit trail; hard delete only for drafts.
  const rows = await query<any[]>(
    "SELECT letter_number, status FROM hr_letters WHERE id = ? LIMIT 1",
    [id],
  )
  const current = rows[0]
  if (!current) return NextResponse.json({ error: "Letter not found" }, { status: 404 })

  if (current.status === "Draft") {
    await logLetterEvent({
      letterId: Number(id),
      letterNumber: current.letter_number,
      type: "deleted",
      summary: "Draft deleted",
      detail: reason ? { reason } : null,
      actorId: session.userId,
      actorName: session.name ?? null,
    })
    await query("DELETE FROM hr_letters WHERE id = ?", [id])
    return NextResponse.json({ ok: true, deleted: true })
  }

  if (current.status === "Cancelled") {
    return NextResponse.json({ error: "Letter is already cancelled" }, { status: 422 })
  }
  if (!reason) {
    return NextResponse.json({ error: "A cancellation reason is required" }, { status: 422 })
  }

  await query(
    "UPDATE hr_letters SET status = 'Cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?",
    [reason, session.userId, id],
  )
  await logLetterEvent({
    letterId: Number(id),
    letterNumber: current.letter_number,
    type: "cancelled",
    summary: `Cancelled: ${reason}`,
    detail: { reason, previous_status: current.status },
    actorId: session.userId,
    actorName: session.name ?? null,
  })
  return NextResponse.json({ ok: true, cancelled: true })
}
