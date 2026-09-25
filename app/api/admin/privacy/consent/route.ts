import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import { listConsentStates, recordConsent } from "@/lib/privacy-consent-store"
import { CONSENT_METHODS, CONSENT_PURPOSES, CONSENT_PURPOSE_LABELS } from "@/lib/privacy-model"

// Spec24 — Consent & notice admin API. Tenant-admin only, tenant-scoped,
// audited. Consent is an append-only ledger; recording always appends a
// "granted" event and withdrawal (separate route) appends a "withdrawn" event.

export const runtime = "nodejs"

function actorFromGuard(guard: Extract<Awaited<ReturnType<typeof requireTenantAdmin>>, { ok: true }>) {
  return { userId: guard.session.userId, name: guard.session.name, email: guard.session.email, role: guard.ctx.tenantRole }
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const states = await listConsentStates(tenantId)
  return NextResponse.json({
    states,
    purposes: CONSENT_PURPOSES.map((p) => ({ key: p, label: CONSENT_PURPOSE_LABELS[p] })),
    methods: CONSENT_METHODS,
  })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const ctx = await captureAuditContext(request).catch(() => undefined)
  try {
    const event = await recordConsent(tenantId, body, actorFromGuard(guard), ctx)
    return NextResponse.json({ event }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
