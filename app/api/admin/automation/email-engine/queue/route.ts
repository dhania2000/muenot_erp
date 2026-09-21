import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { queueTenantEmail } from "@/lib/email-engine/service"
import { EMAIL_MODULES } from "@/lib/email-engine/model"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Administrative entry point for system messages; modules call the same service directly. */
export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  try {
    const body = await request.json()
    if (!EMAIL_MODULES.includes(body.module)) return NextResponse.json({ error: "Invalid email module" }, { status: 400 })
    const message = await queueTenantEmail({ ...body, tenantId, actorId: guard.session.userId })
    return NextResponse.json({ message }, { status: 202 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to queue email" }, { status: 400 }) }
}
