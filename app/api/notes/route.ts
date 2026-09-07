import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export const NOTE_COLORS = ["default", "amber", "emerald", "sky", "rose"] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

// Create the table lazily on first use so the feature works even when the
// migration hasn't been run against the database by hand.
let tableReady = false
export async function ensureNotesTable() {
  if (tableReady) return
  await query(`CREATE TABLE IF NOT EXISTS personal_notes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    color VARCHAR(20) NOT NULL DEFAULT 'default',
    completed TINYINT(1) NOT NULL DEFAULT 0,
    completed_at DATETIME DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_personal_notes_user (user_id),
    KEY idx_personal_notes_user_completed (user_id, completed)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  tableReady = true
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureNotesTable()

  // Active notes first, newest edits on top within each group.
  const notes = await query<any[]>(
    "SELECT id, content, color, completed, completed_at, created_at, updated_at FROM personal_notes WHERE user_id = ? ORDER BY completed ASC, updated_at DESC",
    [session.userId],
  )
  return NextResponse.json({ notes: notes.map((n) => ({ ...n, completed: Boolean(n.completed) })) })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureNotesTable()

  const body = await request.json().catch(() => ({}))
  const content = String(body.content || "").trim()
  const color: NoteColor = NOTE_COLORS.includes(body.color) ? body.color : "default"

  if (!content) return NextResponse.json({ error: "Note cannot be empty" }, { status: 400 })
  if (content.length > 5000) return NextResponse.json({ error: "Note is too long" }, { status: 400 })

  const result = await query<any>(
    "INSERT INTO personal_notes (user_id, content, color) VALUES (?, ?, ?)",
    [session.userId, content, color],
  )
  return NextResponse.json({ ok: true, id: result.insertId }, { status: 201 })
}
