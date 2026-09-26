import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listProviderConfigs, saveProviderConfig, usageSnapshot } from "@/lib/comms-governance/service"
import { CHANNEL_PROVIDERS, COMM_CHANNELS, SUPPRESSION_REASONS, GovernanceError } from "@/lib/comms-governance/model"

/**
 * Spec41 — per-tenant communication provider configuration. Tenant-admin only,
 * strictly tenant-scoped (the tenant id comes from the verified session, never
 * the body), audited by the service, and idempotent through optimistic
 * versioning. Secrets are never accepted here; the model rejects them.
 */

function statusFor(code: string): number {
  if (code === "version_conflict") return 409
  if (code === "invalid_tenant") return 403
  return 400
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const [configs, usage] = await Promise.all([listProviderConfigs(tenantId), usageSnapshot(tenantId)])
  return NextResponse.json({
    configs,
    usage,
    catalog: { channels: COMM_CHANNELS, providers: CHANNEL_PROVIDERS, suppressionReasons: SUPPRESSION_REASONS },
  })
}

export async function PUT(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const body = await request.json().catch(() => ({}))
  const expectedVersion = Number(body?.expectedVersion ?? 0)
  try {
    const config = await saveProviderConfig(tenantId, guard.session.userId, body, expectedVersion)
    return NextResponse.json({ config })
  } catch (err) {
    if (err instanceof GovernanceError) return NextResponse.json({ error: err.message, code: err.code }, { status: statusFor(err.code) })
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
