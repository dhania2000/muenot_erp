import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  FINANCE_EMAIL_EVENTS,
  listAutomationConfigs,
  updateAutomationConfig,
  type FinanceEmailEventKey,
} from "@/lib/finance-email-automation"

/** List every automated finance email event with its enable/template/CC config. */
export async function GET() {
  const session = await requireFeature("finance.emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const events = await listAutomationConfigs()
  // Anyone who can access the emails feature can manage its automation rules.
  return NextResponse.json({ events, canManage: true })
}

/** Enable/disable an event, map it to a template, or toggle accounts auto-CC. */
export async function PATCH(request: NextRequest) {
  const session = await requireFeature("finance.emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const key = body.event_key as FinanceEmailEventKey
  if (!key || !FINANCE_EMAIL_EVENTS[key]) {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 })
  }

  const patch: { enabled?: boolean; template_id?: number | null; cc_accounts?: boolean } = {}
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled
  if (typeof body.cc_accounts === "boolean") patch.cc_accounts = body.cc_accounts
  if ("template_id" in body) {
    patch.template_id = body.template_id == null || body.template_id === "" ? null : Number(body.template_id)
  }

  const ok = await updateAutomationConfig(key, patch, session.userId)
  if (!ok) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  return NextResponse.json({ ok: true })
}
