import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { createAccessPolicy, listAccessPolicies, type AccessPolicyInput } from "@/lib/access-policy-store"
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
  const policies = await listAccessPolicies(ctx.tenantId)
  return NextResponse.json({ policies })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = (await request.json().catch(() => ({}))) as AccessPolicyInput
  try {
    const policy = await createAccessPolicy(ctx.tenantId, ctx.session.userId, body)
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      category: "access_policy",
      action: "policy_created",
      outcome: "created",
      actorUserId: ctx.session.userId,
      actorName: ctx.session.name,
      detail: { id: policy.id, name: policy.name, effect: policy.effect, enabled: policy.enabled },
    })
    return NextResponse.json({ policy }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
