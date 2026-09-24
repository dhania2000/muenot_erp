import { cookies } from "next/headers"
import type { Metadata } from "next"
import { getShareByToken, getDocument, evaluateShareAccess, recipientTypeLabel } from "@/lib/dms"
import { runForTenant } from "@/lib/tenant-scope"
import { getSession } from "@/lib/auth"
import { unlockCookieName, verifyUnlockCookie } from "@/lib/dms/share-access"
import { ShareLanding, ShareUnavailable } from "@/components/dms/share-landing"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Shared document",
  robots: { index: false, follow: false },
}

/**
 * SPEC 89 — public landing page for a share link.
 * This route lives outside the authenticated (workspace) tree and is not matched
 * by the auth middleware, so anyone holding the token can reach it. The token
 * look-up resolves the owning tenant; the pure access gate then decides what the
 * visitor may do. The page never streams file bytes itself — the "View" and
 * "Download" actions call the signed API route, which re-checks the gate and
 * records the access in the audit trail.
 */
export default async function ShareLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { token } = await params
  const { error } = await searchParams

  const found = await getShareByToken(token)
  if (!found) {
    return <ShareUnavailable reason="not_found" />
  }

  const session = await getSession().catch(() => null)
  const viewer = session ? { userId: session.userId, role: session.role } : null

  const cookieStore = await cookies()
  const unlocked = verifyUnlockCookie(token, cookieStore.get(unlockCookieName(token))?.value)

  const { share, passwordHash } = found
  const decision = await runForTenant({ tenantId: found.tenantId }, async () => {
    return evaluateShareAccess({
      share: {
        access: share.access,
        expiresAt: share.expiresAt,
        revokedAt: share.revokedAt,
        recipientType: share.recipientType,
        recipient: share.recipient,
        hasPassword: passwordHash != null,
        maxDownloads: share.maxDownloads,
        downloadCount: share.downloadCount,
      },
      intent: "view",
      viewer,
      passwordVerified: unlocked,
    })
  })

  const doc = await runForTenant({ tenantId: found.tenantId }, () => getDocument(share.documentId))
  const title = doc?.title ?? "Shared document"

  return (
    <ShareLanding
      token={token}
      title={title}
      recipientLabel={recipientTypeLabel(share.recipientType)}
      canDownload={share.access === "download"}
      hasPassword={passwordHash != null}
      unlocked={unlocked}
      decision={decision}
      // A redirect back from the signed route carries a fresh denial reason that
      // supersedes the initial view-intent evaluation (e.g. download_limit).
      redirectError={error ?? null}
    />
  )
}
