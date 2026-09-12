import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureLetterTables } from "@/lib/hr-letters-db"
import { getLetter } from "@/lib/hr-letters-generate"
import { LETTER_STATUSES, type LetterStatus } from "@/lib/hr-letters-shared"

// Single generated letter: detail (with version lineage), status change, cancel.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
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
  return NextResponse.json({ letter, versions })
}

const TIMESTAMP_FOR: Partial<Record<LetterStatus, string>> = {
  Issued: "issued_at",
  Delivered: "delivered_at",
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const to = String(body.status || "").trim() as LetterStatus
  if (!LETTER_STATUSES.includes(to)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 })
  }

  const rows = await query<any[]>("SELECT id, status FROM hr_letters WHERE id = ? LIMIT 1", [id])
  const current = rows[0]
  if (!current) return NextResponse.json({ error: "Letter not found" }, { status: 404 })
  if (current.status === "Cancelled") {
    return NextResponse.json({ error: "A cancelled letter cannot change status" }, { status: 422 })
  }

  const stampCol = TIMESTAMP_FOR[to]
  const stampSql = stampCol ? `, ${stampCol} = COALESCE(${stampCol}, NOW())` : ""
  await query(`UPDATE hr_letters SET status = ?${stampSql} WHERE id = ?`, [to, id])
  const letter = await getLetter(Number(id))
  return NextResponse.json({ letter })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const { id } = await params
  // Soft cancel keeps the audit trail; hard delete only for drafts.
  const rows = await query<any[]>("SELECT status FROM hr_letters WHERE id = ? LIMIT 1", [id])
  if (!rows[0]) return NextResponse.json({ error: "Letter not found" }, { status: 404 })
  if (rows[0].status === "Draft") {
    await query("DELETE FROM hr_letters WHERE id = ?", [id])
    return NextResponse.json({ ok: true, deleted: true })
  }
  await query("UPDATE hr_letters SET status = 'Cancelled' WHERE id = ?", [id])
  return NextResponse.json({ ok: true, cancelled: true })
}
