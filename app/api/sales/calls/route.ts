import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { getCallerId, toE164 } from "@/lib/telnyx"

export const dynamic = "force-dynamic"

// GET /api/sales/calls?leadId=123 — call history (optionally scoped to a lead).
export async function GET(request: Request) {
  const session = await requireFeature("sales.make_calls")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const leadId = searchParams.get("leadId")

  const where: string[] = []
  const params: any[] = []
  if (leadId) {
    where.push("c.lead_id = ?")
    params.push(Number(leadId))
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const calls = await query<any[]>(
    `SELECT c.*, u.name AS called_by_name
       FROM sales_calls c
       LEFT JOIN users u ON u.id = c.called_by
       ${whereSql}
       ORDER BY c.created_at DESC
       LIMIT 200`,
    params,
  )
  return NextResponse.json({ calls })
}

// POST /api/sales/calls — log a call placed from the dialer.
export async function POST(request: Request) {
  const session = await requireFeature("sales.make_calls")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const rawNumber = String(body.to_number || "").trim()
  const toNumber = toE164(rawNumber) || rawNumber
  if (!toNumber) {
    return NextResponse.json({ error: "A phone number is required" }, { status: 400 })
  }

  const leadId = body.lead_id ? Number(body.lead_id) : null
  const toName = body.to_name ? String(body.to_name).slice(0, 190) : null
  const rawCallId = body.telnyx_call_id ?? body.twilio_call_sid
  const providerCallId = rawCallId ? String(rawCallId).slice(0, 64) : null
  const status = normalizeStatus(body.status) || "Initiated"
  const duration = Number.isFinite(Number(body.duration_seconds)) ? Math.max(0, Math.trunc(Number(body.duration_seconds))) : 0
  const disposition = body.disposition ? String(body.disposition).slice(0, 80) : null
  const notes = body.notes ? String(body.notes) : null

  const result = await query<any>(
    `INSERT INTO sales_calls
       (lead_id, to_number, to_name, from_number, twilio_call_sid, direction, status, duration_seconds, disposition, notes, called_by)
     VALUES (?, ?, ?, ?, ?, 'Outbound', ?, ?, ?, ?, ?)`,
    [leadId, toNumber, toName, getCallerId() || null, providerCallId, status, duration, disposition, notes, session.userId],
  )

  return NextResponse.json({ id: result.insertId }, { status: 201 })
}

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

export function normalizeStatus(value: unknown): string | null {
  if (!value) return null
  const s = String(value)
  return VALID_STATUSES.includes(s) ? s : null
}
