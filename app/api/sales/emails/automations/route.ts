import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { userHasFeature } from "@/lib/permissions"
import {
  SALES_EMAIL_EVENTS,
  listSalesAutomationConfigs,
  updateSalesAutomationConfig,
  type SalesEmailEventKey,
} from "@/lib/sales/sales-email-automation"

/** List every automated sales email event with its current enable/template config. */
export async function GET() {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const [events, canManage] = await Promise.all([
    listSalesAutomationConfigs(),
    userHasFeature(session.userId, session.role, "sales.manage_email_templates"),
  ])
  return NextResponse.json({ events, canManage })
}

/** Enable/disable an event or map it to a template. */
export async function PATCH(request: NextRequest) {
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const key = body.event_key as SalesEmailEventKey
  if (!key || !SALES_EMAIL_EVENTS[key]) {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 })
  }

  const patch: { enabled?: boolean; template_id?: number | null } = {}
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled
  if ("template_id" in body) {
    patch.template_id = body.template_id == null || body.template_id === "" ? null : Number(body.template_id)
  }

  const ok = await updateSalesAutomationConfig(key, patch, session.userId)
  if (!ok) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  return NextResponse.json({ ok: true })
}
