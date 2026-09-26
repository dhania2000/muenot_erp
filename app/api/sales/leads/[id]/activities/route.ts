import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { attachLeadEvent } from "@/lib/sales/lead-lifecycle"
import { isValidIdempotencyKey } from "@/lib/collaboration/model"

const ALLOWED_TYPES = new Set(["note", "call", "email", "meeting", "whatsapp", "task"])

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const leadId = Number(id)
  if (!Number.isSafeInteger(leadId) || leadId < 1) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 })
  }
  const body = await request.json().catch(() => ({}))
  const type = ALLOWED_TYPES.has(body.type) ? body.type : "note"
  if (!body.title && !body.body) {
    return NextResponse.json({ error: "A note or title is required" }, { status: 400 })
  }
  const rawKey = request.headers.get("idempotency-key") ?? body.idempotencyKey ?? null
  if (rawKey != null && !isValidIdempotencyKey(rawKey)) {
    return NextResponse.json({ error: "Invalid idempotency key" }, { status: 400 })
  }

  try {
    const attached = await attachLeadEvent({
      leadId,
      type,
      title: String(body.title || (type === "note" ? "Note added" : type)).slice(0, 200),
      body: body.body ? String(body.body).slice(0, 10000) : null,
      actorId: session.userId,
      touchContact: type !== "note",
      idempotencyKey: rawKey,
    })
    // Foreign-tenant and missing leads are indistinguishable (no existence oracle).
    if (!attached) return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[lead-activity] failed", error)
    return NextResponse.json({ error: "Unable to log activity" }, { status: 500 })
  }
}
