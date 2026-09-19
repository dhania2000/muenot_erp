import { getSession } from "@/lib/auth"
import { fetchMediaBinary, getWhatsAppIntegrationByIdForTenant } from "@/lib/whatsapp"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"
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

  let mediaRows = await query<{ integration_id: number | null }[]>(
    "SELECT integration_id FROM `marketing_whatsapp_media` WHERE media_id = ? AND tenant_id = ? LIMIT 1",
    [mediaId, currentTenantId()],
  )
  if (!mediaRows[0]) {
    mediaRows = await query<{ integration_id: number | null }[]>(
      "SELECT m.integration_id FROM `marketing_whatsapp_messages` m JOIN `marketing_whatsapp_conversations` c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id WHERE m.media_id = ? AND m.tenant_id = ? LIMIT 1",
      [mediaId, currentTenantId()],
    )
  }
  if (!mediaRows[0]) return new Response("Media not found", { status: 404 })
  const integration = mediaRows[0].integration_id != null
    ? await getWhatsAppIntegrationByIdForTenant(mediaRows[0].integration_id, currentTenantId())
    : null
  if (!integration) return new Response("No WhatsApp account connected", { status: 400 })

  const result = await fetchMediaBinary(integration, mediaId)
  if (!result.ok) return new Response(result.error, { status: 502 })

  // Best-effort metadata capture (never blocks the response).
  recordMedia({
    mediaId,
    integrationId: integration.id,
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
