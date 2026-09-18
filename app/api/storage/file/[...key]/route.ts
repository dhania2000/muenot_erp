import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { downloadFile, keyBelongsToTenant } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * Tenant-scoped download proxy for objects stored on a customer's own
 * S3-compatible backend (private buckets don't expose direct URLs). Every
 * request is authenticated and the object key MUST belong to the caller's
 * session tenant — a forged or guessed key from another tenant is rejected with
 * a 404, so files can never cross the tenant boundary.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const tenantId = currentTenantIdOrNull()
  if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const { key: segments } = await params
  const key = segments.map((s) => decodeURIComponent(s)).join("/")

  // Isolation guard: the key's tenant segment must match the session tenant.
  if (!keyBelongsToTenant(key, tenantId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
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
