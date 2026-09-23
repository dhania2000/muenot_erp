import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { createIpAllowlistEntry, listIpAllowlistEntries } from "@/lib/ip-allowlist-store"
import { getBool, setBool } from "@/lib/settings/server"
import { recordSecurityEvent } from "@/lib/security-audit-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  return { session, tenantId: tenant?.tenantId ?? null }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const [entries, enabled, emergencyBypass] = await Promise.all([
    listIpAllowlistEntries(ctx.tenantId),
    getBool("security.ip_allowlist_enabled", false),
    getBool("security.ip_allowlist_emergency_bypass", false),
  ])
  return NextResponse.json({ entries, enabled, emergencyBypass })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))

  if (typeof body.enabled === "boolean") {
    await setBool("security.ip_allowlist_enabled", body.enabled)
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      category: "ip_allowlist",
      action: body.enabled ? "enforcement_enabled" : "enforcement_disabled",
      outcome: "updated",
      actorUserId: ctx.session.userId,
      actorName: ctx.session.name,
    })
    return NextResponse.json({ enabled: body.enabled })
  }

  if (typeof body.emergencyBypass === "boolean") {
    await setBool("security.ip_allowlist_emergency_bypass", body.emergencyBypass)
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      category: "ip_allowlist",
      action: body.emergencyBypass ? "emergency_bypass_enabled" : "emergency_bypass_disabled",
      outcome: "updated",
      actorUserId: ctx.session.userId,
      actorName: ctx.session.name,
    })
    return NextResponse.json({ emergencyBypass: body.emergencyBypass })
  }

  const { label, cidr, mode, scope } = body as {
    label?: string
    cidr?: string
    mode?: string
    scope?: string
  }
  if (!label || !cidr) {
    return NextResponse.json({ error: "Label and CIDR range are required" }, { status: 400 })
  }
  try {
    const entry = await createIpAllowlistEntry({
      tenantId: ctx.tenantId,
      label,
      cidr,
      mode: mode === "block" ? "block" : "allow",
      scope: scope === "admin" ? "admin" : "all",
      createdBy: ctx.session.userId,
    })
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      category: "ip_allowlist",
      action: "range_added",
      outcome: "created",
      actorUserId: ctx.session.userId,
      actorName: ctx.session.name,
      detail: { id: entry.id, label: entry.label, cidr: entry.cidr, mode: entry.mode, scope: entry.scope },
    })
    return NextResponse.json({ entry }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
