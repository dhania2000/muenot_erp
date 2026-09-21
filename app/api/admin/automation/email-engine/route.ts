import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { configureTenantEmailSender, listTenantEmails } from "@/lib/email-engine/service"
import { EMAIL_MODULES } from "@/lib/email-engine/model"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  try { return NextResponse.json({ emails: await listTenantEmails(tenantId) }) }
  catch { return NextResponse.json({ error: "Unable to load centralized email activity" }, { status: 500 }) }
}

export async function PUT(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  try {
    const body = await request.json()
    if (!EMAIL_MODULES.includes(body.module)) return NextResponse.json({ error: "Invalid email module" }, { status: 400 })
    await configureTenantEmailSender({ tenantId, actorId: guard.session.userId, module: body.module, fromName: body.fromName, fromAddress: body.fromAddress, replyTo: body.replyTo, transportDepartment: body.transportDepartment })
    return NextResponse.json({ ok: true })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save sender" }, { status: 400 }) }
}
