import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { insertSocialMedia } from "@/lib/social-media"

/**
 * Accepts an in-browser image (as a data URL) from the Create wizard, stores
 * the bytes in MySQL, and returns a public https URL that platforms — notably
 * Instagram — can fetch. The returned URL is what gets saved on the post and
 * sent to each platform at publish time.
 */

const MAX_BYTES = 8 * 1024 * 1024 // 8 MB

function publicBase(request: Request) {
  const configured = process.env.SOCIAL_PUBLIC_BASE || process.env.SOCIAL_REDIRECT_BASE
  if (configured) return configured.replace(/\/+$/, "")

  // Behind a proxy, request.url reflects the internal bind address
  // (e.g. 0.0.0.0:3000), which platforms like Instagram cannot fetch. Prefer
  // the forwarded host/proto headers set by the proxy when present.
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host")
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https"
  if (forwardedHost && !/^0\.0\.0\.0|^localhost|^127\./.test(forwardedHost)) {
    return `${forwardedProto}://${forwardedHost}`
  }
  return new URL(request.url).origin
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  const image = typeof body?.image === "string" ? body.image : ""
  const match = /^data:(.+?);base64,(.*)$/.exec(image)
  if (!match) return NextResponse.json({ error: "Invalid image data" }, { status: 400 })

  const contentType = match[1]
  if (!/^image\//.test(contentType)) {
    return NextResponse.json({ error: "Only image files are allowed" }, { status: 400 })
  }

  const buffer = Buffer.from(match[2], "base64")
  if (buffer.length === 0) return NextResponse.json({ error: "Empty image" }, { status: 400 })
  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "Image too large (max 8MB)" }, { status: 400 })
  }

  const id = await insertSocialMedia(buffer, contentType, session.userId)
  const url = `${publicBase(request)}/api/marketing/social/media/${id}`
  return NextResponse.json({ id, url })
}
