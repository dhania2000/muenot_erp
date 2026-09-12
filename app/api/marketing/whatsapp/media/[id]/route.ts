import { getSession } from "@/lib/auth"
import { fetchMediaBinary, getWhatsAppIntegration } from "@/lib/whatsapp"
import { recordMedia } from "@/lib/whatsapp-platform"

/**
 * Secure server-side proxy for inbound WhatsApp media.
 *
 * The browser never sees the Graph API access token: it requests
 * /api/marketing/whatsapp/media/<mediaId>, we authenticate the ERP session,
 * download the bytes from Meta with the stored token, record the media
 * metadata, and stream the binary back. The token is never placed in a URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return new Response("Unauthorized", { status: 401 })

  const { id } = await params
  const mediaId = String(id || "").trim()
  if (!mediaId) return new Response("Invalid media id", { status: 400 })

  const integration = await getWhatsAppIntegration()
  if (!integration) return new Response("No WhatsApp account connected", { status: 400 })

  const result = await fetchMediaBinary(integration, mediaId)
  if (!result.ok) return new Response(result.error, { status: 502 })

  // Best-effort metadata capture (never blocks the response).
  recordMedia({
    mediaId,
    mimeType: result.contentType,
    fileSize: result.data.byteLength,
  }).catch(() => {})

  return new Response(result.data, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
