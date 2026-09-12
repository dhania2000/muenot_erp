import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getLeadFollowups, createFollowUp, ensureLeadLifecycleSchema, LeadNotFoundError } from "@/lib/sales/lead-lifecycle"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()
  const { id } = await params
  const followups = await getLeadFollowups(Number(id))
  return NextResponse.json({ followups })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.due_at) return NextResponse.json({ error: "A due date/time is required" }, { status: 400 })

  try {
    const created = await createFollowUp(
      {
        leadId: Number(id),
        dueAt: body.due_at,
        channel: body.channel || null,
        purpose: body.purpose || null,
        assignedTo: body.assigned_to ? Number(body.assigned_to) : null,
      },
      session.userId,
    )
    return NextResponse.json(created)
  } catch (error) {
    if (error instanceof LeadNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[followup-create] failed", error)
    return NextResponse.json({ error: "Unable to schedule follow-up" }, { status: 500 })
  }
}
