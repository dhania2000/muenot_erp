import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import { withdrawConsent } from "@/lib/privacy-consent-store"

// Spec24 — Withdraw consent. Appends a "withdrawn" event to the ledger so the
// lawful basis is revoked while the full history is preserved for audit.

export const runtime = "nodejs"

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const ctx = await captureAuditContext(request).catch(() => undefined)
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }
  try {
    const event = await withdrawConsent(tenantId, body, actor, ctx)
    return NextResponse.json({ event })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
