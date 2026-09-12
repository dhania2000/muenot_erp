import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  HR_EMAIL_EVENTS,
  listAutomationConfigs,
  updateAutomationConfig,
  type HrEmailEventKey,
} from "@/lib/hr-email-automation"

/** List every automated HR email event with its current enable/template/CC config. */
export async function GET() {
  const session = await requireFeature("hr.view_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const events = await listAutomationConfigs()
  return NextResponse.json({ events })
}

/** Enable/disable an event, map it to a template, or toggle manager auto-CC. */
export async function PATCH(request: NextRequest) {
  const session = await requireFeature("hr.manage_email_automation")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const key = body.event_key as HrEmailEventKey
  if (!key || !HR_EMAIL_EVENTS[key]) {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 })
  }

  const patch: { enabled?: boolean; template_id?: number | null; cc_manager?: boolean } = {}
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled
  if (typeof body.cc_manager === "boolean") patch.cc_manager = body.cc_manager
  if ("template_id" in body) {
    patch.template_id = body.template_id == null || body.template_id === "" ? null : Number(body.template_id)
  }

  const ok = await updateAutomationConfig(key, patch, session.userId)
  if (!ok) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  return NextResponse.json({ ok: true })
}
