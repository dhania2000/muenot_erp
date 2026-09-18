import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { downloadFile, keyBelongsToTenant } from "@/lib/storage"
import { verifySignedProxyToken } from "@/lib/storage/signing"

export const runtime = "nodejs"

/**
 * SPEC 29 — Tenant-scoped download proxy for objects served through the app
 * (managed Vercel Blob, and any S3 object we don't hand a native presigned URL
 * for). Access is granted one of two ways, and the object key's tenant segment
 * MUST match in BOTH — a forged/guessed key from another tenant returns 404:
 *
 *   1. A valid session whose tenant owns the key (interactive browsing).
 *   2. A short-lived HMAC-signed token bound to this exact key (cookieless
 *      contexts: <img>/<embed>, PDF renderers, emailed links). The token IS
 *      the capability, so no session is required, but it expires quickly and
 *      only authorizes the single object it was minted for.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: segments } = await params
  const key = segments.map((s) => decodeURIComponent(s)).join("/")

  const exp = req.nextUrl.searchParams.get("exp")
  const sig = req.nextUrl.searchParams.get("sig")

  if (sig) {
    // Signed-URL path: verify the token covers THIS key and hasn't expired.
    const verdict = verifySignedProxyToken(key, exp, sig)
    if (!verdict.valid) {
      const status = verdict.reason === "expired" ? 410 : 403
      return NextResponse.json({ error: verdict.reason === "expired" ? "Link expired" : "Forbidden" }, { status })
    }
    // The token binds the URL to its tenant; no cross-tenant recheck needed
    // because the tenant segment is part of the signed material.
  } else {
    // Session path: authenticate and require the session tenant to own the key.
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const tenantId = currentTenantIdOrNull()
    if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
    if (!keyBelongsToTenant(key, tenantId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
  }

  try {
    const obj = await downloadFile(key)
    const headers = new Headers()
    headers.set("Content-Type", obj.contentType || "application/octet-stream")
    if (obj.size != null) headers.set("Content-Length", String(obj.size))
    // Objects are per-tenant private content; keep them out of shared caches.
    headers.set("Cache-Control", "private, max-age=0, no-store")
    const body = obj.body instanceof Buffer ? new Uint8Array(obj.body) : (obj.body as ReadableStream<Uint8Array>)
    return new NextResponse(body as any, { status: 200, headers })
  } catch (err) {
    console.error("[v0] storage download failed:", err)
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
}
