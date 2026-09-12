import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createAutomation, listAutomations } from "@/lib/whatsapp-automations"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationTrigger,
} from "@/lib/whatsapp-config"

/** Lists all automation rules (any authenticated agent may read). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const automations = await listAutomations()
  return NextResponse.json({ automations })
}

/** Creates an automation rule (requires the manage-automation capability). */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canManageAutomation) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    triggerType?: string
    triggerConfig?: Record<string, unknown>
    actionType?: string
    actionConfig?: Record<string, unknown>
    departmentId?: number | null
    priority?: number
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 })
  if (!AUTOMATION_TRIGGERS.includes(body.triggerType as AutomationTrigger)) {
    return NextResponse.json({ error: "Invalid trigger" }, { status: 400 })
  }
  if (!AUTOMATION_ACTIONS.includes(body.actionType as AutomationAction)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  }

  const id = await createAutomation({
    name: body.name,
    triggerType: body.triggerType as AutomationTrigger,
    triggerConfig: body.triggerConfig ?? {},
    actionType: body.actionType as AutomationAction,
    actionConfig: body.actionConfig ?? {},
    departmentId: body.departmentId ?? null,
    priority: Number(body.priority) || 0,
    createdBy: session.userId,
  })
  const automations = await listAutomations()
  return NextResponse.json({ ok: true, id, automations }, { status: 201 })
}
