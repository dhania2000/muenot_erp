import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { NOTE_COLORS, ensureNotesTable } from "../route"

// Update a note: edit its text, change its color, or toggle completed.
// Every statement is scoped to the session user so one employee can never
// touch another employee's notes.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureNotesTable()

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const sets: string[] = []
  const values: unknown[] = []

  if (typeof body.content === "string") {
    const content = body.content.trim()
    if (!content) return NextResponse.json({ error: "Note cannot be empty" }, { status: 400 })
    sets.push("content = ?")
    values.push(content.slice(0, 5000))
  }
  if (typeof body.color === "string" && (NOTE_COLORS as readonly string[]).includes(body.color)) {
    sets.push("color = ?")
    values.push(body.color)
  }
  if (typeof body.completed === "boolean") {
    sets.push("completed = ?", "completed_at = ?")
    values.push(body.completed ? 1 : 0, body.completed ? new Date() : null)
  }

  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })

  values.push(id, session.userId)
  const result = await query<any>(
    `UPDATE personal_notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
    values,
  )
  if (!result.affectedRows) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureNotesTable()

  const { id } = await params
  const result = await query<any>(
    "DELETE FROM personal_notes WHERE id = ? AND user_id = ?",
    [id, session.userId],
  )
  if (!result.affectedRows) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
