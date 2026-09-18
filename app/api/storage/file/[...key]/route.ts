import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { downloadFile, keyBelongsToTenant } from "@/lib/storage"
import { verifySignedProxyToken } from "@/lib/storage/signing"
import {
  mediaKindFor,
  cacheControlFor,
  contentDispositionFor,
  filenameFromKey,
  isRangeable,
  type DeliveryAccess,
} from "@/lib/storage/cdn"

export const runtime = "nodejs"

/**
 * SPEC 29 + SPEC 31 — Tenant-scoped media delivery proxy.
 * ---------------------------------------------------------------------------
 * ACCESS (SPEC 29): a request is authorised one of two ways, and the object
 * key's tenant segment MUST match in BOTH — a forged/guessed cross-tenant key
 * returns 404:
 *   1. A valid session whose tenant owns the key (interactive browsing), or
 *   2. A short-lived HMAC-signed token bound to this exact key (cookieless
 *      contexts: <img>/<video>/<embed>, PDF viewers, emailed links).
 *
 * DELIVERY (SPEC 31): once authorised, the object is streamed with CDN-friendly
 * semantics driven by lib/storage/cdn.ts:
 *   - HTTP Range → 206 Partial Content (seekable video/audio, CDN slice fetch),
 *   - per-media-kind Cache-Control (signed URLs are cacheable per-URL for the
 *     token's remaining life; interactive session reads are never shared-cached),
 *   - Content-Disposition inline for media, attachment for document downloads
 *     (or when `?download=1`), with a sensible filename,
 *   - ETag / Last-Modified / Accept-Ranges for validation and range support.
 *
 * Native S3 backends usually hand the browser a presigned URL that hits S3
 * directly (which already speaks Range); this proxy is the delivery path for
 * managed Blob storage and any object served with a signed proxy URL.
 */

type Access = { ok: true; kind: DeliveryAccess; remainingTtl: number | null } | { ok: false; res: NextResponse }

async function authorize(req: NextRequest, key: string): Promise<Access> {
  const exp = req.nextUrl.searchParams.get("exp")
  const sig = req.nextUrl.searchParams.get("sig")

  if (sig) {
    const verdict = verifySignedProxyToken(key, exp, sig)
    if (!verdict.valid) {
      const status = verdict.reason === "expired" ? 410 : 403
      return {
        ok: false,
        res: NextResponse.json({ error: verdict.reason === "expired" ? "Link expired" : "Forbidden" }, { status }),
      }
    }
    const remainingTtl = exp ? Math.max(0, Number(exp) - Math.floor(Date.now() / 1000)) : null
    return { ok: true, kind: "signed", remainingTtl }
  }

  const session = await getSession()
  if (!session) return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const tenantId = currentTenantIdOrNull()
  if (!tenantId) return { ok: false, res: NextResponse.json({ error: "No tenant in context" }, { status: 400 }) }
  if (!keyBelongsToTenant(key, tenantId)) {
    return { ok: false, res: NextResponse.json({ error: "Not found" }, { status: 404 }) }
  }
  return { ok: true, kind: "session", remainingTtl: null }
}

function keyFromParams(segments: string[]): string {
  return segments.map((s) => decodeURIComponent(s)).join("/")
}

/** Decide whether to force an attachment download from the query string. */
function dispositionOverride(req: NextRequest): boolean | undefined {
  const v = req.nextUrl.searchParams.get("download") ?? req.nextUrl.searchParams.get("disposition")
  if (v == null) return undefined
  if (v === "0" || v === "inline" || v === "false") return false
  return true // "1", "attachment", "true", or any present value
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: segments } = await params
  const key = keyFromParams(segments)

  const auth = await authorize(req, key)
  if (!auth.ok) return auth.res

  const rangeHeader = req.headers.get("range")

  try {
    const obj = await downloadFile(key, { range: rangeHeader })
    const kind = mediaKindFor(obj.contentType, key)
    const headers = buildHeaders({ req, key, obj, kind, access: auth.kind, remainingTtl: auth.remainingTtl })

    const status = obj.isPartial ? 206 : 200
    const body = obj.body instanceof Buffer ? new Uint8Array(obj.body) : (obj.body as ReadableStream<Uint8Array>)
    return new NextResponse(body as any, { status, headers })
  } catch (err) {
    console.error("[v0] storage download failed:", err)
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
}

/**
 * HEAD — return delivery headers (type, length, cache, disposition, ranges)
 * without a body. Uses a 1-byte range probe so we never stream the whole
 * object just to answer metadata; the true size comes from Content-Range.
 */
export async function HEAD(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: segments } = await params
  const key = keyFromParams(segments)

  const auth = await authorize(req, key)
  if (!auth.ok) return new NextResponse(null, { status: auth.res.status })

  try {
    const probe = await downloadFile(key, { range: "bytes=0-0" })
    // Drain/cancel the tiny probe body so we don't leak a stream.
    if (probe.body instanceof ReadableStream) await probe.body.cancel().catch(() => {})
    const kind = mediaKindFor(probe.contentType, key)
    const totalSize = probe.totalSize ?? probe.size ?? null
    const headers = buildHeaders({
      req,
      key,
      obj: { ...probe, isPartial: false, contentRange: null, size: totalSize },
      kind,
      access: auth.kind,
      remainingTtl: auth.remainingTtl,
    })
    headers.delete("Content-Range")
    return new NextResponse(null, { status: 200, headers })
  } catch (err) {
    console.error("[v0] storage HEAD failed:", err)
    return new NextResponse(null, { status: 404 })
  }
}

function buildHeaders(args: {
  req: NextRequest
  key: string
  obj: {
    contentType: string | null
    size: number | null
    totalSize?: number | null
    etag?: string | null
    lastModified?: string | null
    isPartial?: boolean
    contentRange?: string | null
  }
  kind: ReturnType<typeof mediaKindFor>
  access: DeliveryAccess
  remainingTtl: number | null
}): Headers {
  const { req, key, obj, kind, access, remainingTtl } = args
  const headers = new Headers()

  headers.set("Content-Type", obj.contentType || "application/octet-stream")
  if (obj.size != null) headers.set("Content-Length", String(obj.size))

  // SPEC 31 — media-aware, context-aware cache policy.
  headers.set("Cache-Control", cacheControlFor({ access, kind, remainingTtlSeconds: remainingTtl }))

  // Content-Disposition: inline for media, attachment for documents/downloads.
  const forceDownload = dispositionOverride(req)
  const filename = req.nextUrl.searchParams.get("filename") || filenameFromKey(key)
  headers.set("Content-Disposition", contentDispositionFor({ kind, filename, forceDownload }))

  // Range support advertisement + partial metadata.
  headers.set("Accept-Ranges", "bytes")
  if (obj.isPartial && obj.contentRange) headers.set("Content-Range", obj.contentRange)

  // Cache validators.
  if (obj.etag) headers.set("ETag", obj.etag)
  if (obj.lastModified) headers.set("Last-Modified", obj.lastModified)

  // Caches must key on the authorization so a signed and a session response are
  // never crossed, and keep the app from being framed for non-media documents.
  headers.set("Vary", "Range, Authorization, Cookie")
  headers.set("X-Content-Type-Options", "nosniff")
  if (!isRangeable(kind) && kind === "document") headers.set("X-Frame-Options", "SAMEORIGIN")

  return headers
}
