import { NextRequest, NextResponse } from "next/server"
import { runForTenant } from "@/lib/tenant-scope"
import { getShareByToken, logAudit } from "@/lib/dms"
import {
  unlockCookieName,
  signUnlockCookie,
  verifySharePassword,
  UNLOCK_TTL_SECONDS,
} from "@/lib/dms/share-access"

export const runtime = "nodejs"

/**
 * Verify a share-link password and, on success, set a short-lived HMAC-signed
 * unlock cookie bound to this one token. The plaintext password is compared
 * against the stored bcrypt hash and never logged.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const password = typeof body.password === "string" ? body.password : ""

  const found = await getShareByToken(token)
  if (!found) return NextResponse.json({ error: "Link not found" }, { status: 404 })
  if (!found.passwordHash) {
    // Nothing to unlock — treat as already open so the client can proceed.
    return NextResponse.json({ ok: true })
  }

  const ok = await verifySharePassword(password, found.passwordHash)

  await runForTenant({ tenantId: found.tenantId }, async () => {
    await logAudit({
      documentId: found.share.documentId,
      shareId: found.share.id,
      action: ok ? "share_unlock" : "share_unlock_failed",
      detail: found.share.recipientType,
    })
  })

  if (!ok) return NextResponse.json({ error: "Incorrect password" }, { status: 401 })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(unlockCookieName(token), signUnlockCookie(token), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: UNLOCK_TTL_SECONDS,
  })
  return res
}
