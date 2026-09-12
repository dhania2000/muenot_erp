import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { ensureHrEmailHubSchema, sendHrEmailRow } from "@/lib/hr-email"

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.view_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureHrEmailHubSchema()
  const { id } = await params
  const rows = await query<any[]>("SELECT * FROM hr_emails WHERE id = ? LIMIT 1", [Number(id)])
  if (!rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ email: rows[0] })
}

/** Lifecycle actions: cancel a pending/draft email, or (re)send it now. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.send_email")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureHrEmailHubSchema()

  const { id } = await params
  const numericId = Number(id)
  const { action } = await request.json().catch(() => ({}))

  const rows = await query<any[]>("SELECT status FROM hr_emails WHERE id = ? LIMIT 1", [numericId])
  const row = rows[0]
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (action === "cancel") {
    if (row.status === "Sent") {
      return NextResponse.json({ error: "Sent emails cannot be cancelled" }, { status: 400 })
    }
    await query("UPDATE hr_emails SET status='Cancelled' WHERE id=?", [numericId])
    return NextResponse.json({ ok: true, status: "Cancelled" })
  }

  if (action === "send" || action === "resend") {
    const result = await sendHrEmailRow(numericId)
    return NextResponse.json({ ok: result.status === "Sent", status: result.status, error: result.error })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
