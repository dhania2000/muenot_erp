import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { attachLeadEvent } from "@/lib/sales/lead-lifecycle"

const ALLOWED_TYPES = new Set(["note", "call", "email", "meeting", "whatsapp", "task"])

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const type = ALLOWED_TYPES.has(body.type) ? body.type : "note"
  if (!body.title && !body.body) {
    return NextResponse.json({ error: "A note or title is required" }, { status: 400 })
  }

  try {
    await attachLeadEvent({
      leadId: Number(id),
      type,
      title: body.title || (type === "note" ? "Note added" : type),
      body: body.body || null,
      actorId: session.userId,
      touchContact: type !== "note",
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[lead-activity] failed", error)
    return NextResponse.json({ error: "Unable to log activity" }, { status: 500 })
  }
}
