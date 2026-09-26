import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { addSuppression, listSuppressions } from "@/lib/comms-governance/service"
import { GovernanceError, isChannel } from "@/lib/comms-governance/model"

/**
 * Spec41 — tenant suppression list. Tenant-admin only, tenant-scoped and
 * audited. Admins may add a MANUAL suppression (e.g. an abuse report handled
 * off-platform); consent-driven reasons are created only by provider events or
 * the recipient, never by an admin here.
 */

export async function GET(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const url = new URL(request.url)
  const channelParam = url.searchParams.get("channel")
  const channel = channelParam && isChannel(channelParam) ? channelParam : undefined
  const limit = Number(url.searchParams.get("limit") ?? 100)
  const suppressions = await listSuppressions(tenantId, { channel, limit })
  return NextResponse.json({ suppressions })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const body = await request.json().catch(() => ({}))
  if (!isChannel(body?.channel)) return NextResponse.json({ error: "Unknown channel", code: "invalid_channel" }, { status: 400 })
  try {
    // Admin-created suppressions are always "manual" — consent withdrawals
    // (complaint / opt_out) can only originate from a provider or the recipient.
    await addSuppression(tenantId, {
      channel: body.channel,
      address: String(body?.address ?? ""),
      reason: "manual",
      source: "admin",
      actorId: guard.session.userId,
    })
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    if (err instanceof GovernanceError) return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
