import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { resolveTenantIdForUser } from "@/lib/tenant-service"
import { getPublicSettings } from "@/lib/settings/server"
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  getLifecycleUser,
  LifecycleError,
} from "@/lib/user-lifecycle"

/**
 * SPEC 14 — Self-service MFA (TOTP) enrollment for the signed-in user.
 *   POST   → begin enrollment; returns a secret + otpauth:// URL to show as QR.
 *   PUT    → confirm enrollment with a live 6-digit code; returns backup codes.
 *   DELETE → disable MFA for the caller's own account.
 * Everything is scoped to the caller's own user id and home tenant.
 */
async function resolveSelf() {
  const session = await getSession()
  if (!session) return null
  const tenantId = await resolveTenantIdForUser(session.userId)
  if (tenantId == null) return null
  return { session, tenantId }
}

export async function GET() {
  const self = await resolveSelf()
  if (!self) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const user = await getLifecycleUser(self.tenantId, self.session.userId)
  return NextResponse.json({ mfaEnabled: Boolean(user?.mfaEnabled) })
}

export async function POST() {
  const self = await resolveSelf()
  if (!self) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const settings = await getPublicSettings()
  const issuer = (settings["company.name"] as string) || "Muenot ERP"
  try {
    const enrollment = await beginMfaEnrollment(self.tenantId, self.session.userId, issuer)
    return NextResponse.json(enrollment)
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[auth/mfa] begin failed:", err)
    return NextResponse.json({ error: "Failed to start MFA enrollment" }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const self = await resolveSelf()
  if (!self) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  try {
    const { backupCodes } = await confirmMfaEnrollment(self.tenantId, self.session.userId, String(body?.code ?? ""), {
      userId: self.session.userId,
      email: self.session.email,
    })
    return NextResponse.json({ ok: true, backupCodes })
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[auth/mfa] confirm failed:", err)
    return NextResponse.json({ error: "Failed to confirm MFA" }, { status: 500 })
  }
}

export async function DELETE() {
  const self = await resolveSelf()
  if (!self) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    await disableMfa(self.tenantId, self.session.userId, { userId: self.session.userId, email: self.session.email })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[auth/mfa] disable failed:", err)
    return NextResponse.json({ error: "Failed to disable MFA" }, { status: 500 })
  }
}
