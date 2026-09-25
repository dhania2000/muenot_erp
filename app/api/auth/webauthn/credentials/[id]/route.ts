import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { revokeCredential, getCredentialById } from "@/lib/webauthn-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"

/**
 * Revoke one of the signed-in user's own passkeys. Tenant + owner scoped: the
 * delete is constrained by (tenant, user, id) so a user can never revoke
 * another user's or another tenant's credential even by guessing its id.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const tenantId = session.tenantId
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const credentialRowId = Number(id)
  if (!Number.isInteger(credentialRowId) || credentialRowId <= 0) {
    return NextResponse.json({ error: "Invalid credential id" }, { status: 400 })
  }

  const existing = await getCredentialById(tenantId, session.userId, credentialRowId)
  const revoked = await revokeCredential(tenantId, session.userId, credentialRowId)
  if (!revoked) {
    return NextResponse.json({ error: "Credential not found" }, { status: 404 })
  }

  await recordSecurityEvent({
    tenantId,
    category: "access_policy",
    action: "webauthn_revoked",
    outcome: "revoked",
    actorUserId: session.userId,
    actorName: session.name,
    subjectEmail: session.email,
    detail: { label: existing?.label ?? null },
  })

  return NextResponse.json({ ok: true })
}
