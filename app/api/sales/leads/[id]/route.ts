import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  getLead,
  updateLead,
  recordAudit,
  ensureLeadLifecycleSchema,
  LeadConflictError,
  LeadNotFoundError,
} from "@/lib/sales/lead-lifecycle"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()
  const { id } = await params
  const lead = await getLead(Number(id))
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })
  return NextResponse.json({ lead })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const { expected_version, note, ...patch } = body

  try {
    const lead = await updateLead(Number(id), patch, session.userId, {
      expectedVersion: expected_version,
      note,
    })
    return NextResponse.json({ success: true, lead })
  } catch (error) {
    if (error instanceof LeadConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof LeadNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error("[lead-update] failed", error)
    return NextResponse.json({ error: "Unable to update lead" }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await query("DELETE FROM sales_leads WHERE id = ?", [id])
  await recordAudit(null, { entityType: "lead", entityId: id, action: "delete", summary: "Lead deleted", actorId: session.userId })
  return NextResponse.json({ success: true })
}
