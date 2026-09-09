import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"

const VALID_STATUSES = [
  "Initiated",
  "Ringing",
  "In Progress",
  "Completed",
  "Failed",
  "Busy",
  "No Answer",
  "Canceled",
]

// PATCH /api/sales/calls/:id — update outcome (status, duration, disposition, notes).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.make_calls")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const callId = Number(id)
  if (!Number.isFinite(callId)) {
    return NextResponse.json({ error: "Invalid call id" }, { status: 400 })
  }

  const body = await request.json().catch(() => ({}))
  const sets: string[] = []
  const values: any[] = []

  if (body.status && VALID_STATUSES.includes(String(body.status))) {
    sets.push("status = ?")
    values.push(String(body.status))
  }
  if (body.duration_seconds !== undefined) {
    sets.push("duration_seconds = ?")
    values.push(Math.max(0, Math.trunc(Number(body.duration_seconds) || 0)))
  }
  if (body.disposition !== undefined) {
    sets.push("disposition = ?")
    values.push(body.disposition ? String(body.disposition).slice(0, 80) : null)
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?")
    values.push(body.notes ? String(body.notes) : null)
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  values.push(callId)
  await query(`UPDATE sales_calls SET ${sets.join(", ")} WHERE id = ?`, values)

  return NextResponse.json({ ok: true })
}
