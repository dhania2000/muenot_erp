import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteAutomation, listAutomations, updateAutomation } from "@/lib/whatsapp-automations"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** Updates an automation rule — toggle active, change trigger/action/priority. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canManageAutomation) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const automationId = Number(id)
  if (!Number.isInteger(automationId) || automationId <= 0) {
    return NextResponse.json({ error: "Invalid automation id" }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    isActive?: boolean
    triggerType?: string
    triggerConfig?: Record<string, unknown>
    actionType?: string
    actionConfig?: Record<string, unknown>
    departmentId?: number | null
    priority?: number
  }

  await updateAutomation(automationId, body)
  const automations = await listAutomations()
  return NextResponse.json({ ok: true, automations })
}

/** Deletes an automation rule. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canManageAutomation) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const automationId = Number(id)
  if (!Number.isInteger(automationId) || automationId <= 0) {
    return NextResponse.json({ error: "Invalid automation id" }, { status: 400 })
  }

  await deleteAutomation(automationId)
  const automations = await listAutomations()
  return NextResponse.json({ ok: true, automations })
}
