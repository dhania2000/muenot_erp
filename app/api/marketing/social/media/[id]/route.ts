import { getSocialMedia } from "@/lib/social-media"

/**
 * Public, unauthenticated image endpoint. Platforms like Instagram fetch the
 * post image from this URL with their own servers, so it must NOT require a
 * session. Only opaque numeric ids are exposed and only image bytes are
 * returned.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mediaId = Number(id)
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return new Response("Not found", { status: 404 })
  }

  const media = await getSocialMedia(mediaId)
  if (!media) return new Response("Not found", { status: 404 })

  return new Response(new Uint8Array(media.data), {
    status: 200,
    headers: {
      "Content-Type": media.content_type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
