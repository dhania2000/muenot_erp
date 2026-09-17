import { query } from "@/lib/db"
import { recordContactActivity } from "@/lib/marketing/contacts-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// 1x1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")

function pixelResponse() {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  })
}

/** Open pixel. Always returns the GIF, even on error, so mail clients render cleanly. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    if (token && !token.startsWith("test-")) {
      const rows = await query<any[]>(
        `SELECT id, campaign_id, contact_id, contact_code, status, open_count FROM marketing_campaign_recipients WHERE tracking_token = ? LIMIT 1`,
        [token],
      )
      const r = rows[0]
      if (r) {
        const ua = request.headers.get("user-agent")?.slice(0, 400) || null
        const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim().slice(0, 64) || null
        await query(
          `UPDATE marketing_campaign_recipients
              SET open_count = open_count + 1,
                  first_opened_at = COALESCE(first_opened_at, NOW()),
                  last_opened_at = NOW(),
                  status = CASE WHEN status IN ('Sent','Delivered') THEN 'Opened' ELSE status END
            WHERE id = ?`,
          [r.id],
        )
        await query(
          `INSERT INTO marketing_campaign_events (campaign_id, recipient_id, event_type, user_agent, ip_address) VALUES (?,?,'open',?,?)`,
          [r.campaign_id, r.id, ua, ip],
        )
        // Only log the first open to the contact timeline to avoid noise.
        if (Number(r.open_count || 0) === 0 && r.contact_id) {
          await recordContactActivity({
            contactId: Number(r.contact_id),
            contactCode: r.contact_code,
            type: "campaign",
            summary: "Opened a campaign email",
            meta: { campaign_id: r.campaign_id },
          }).catch(() => {})
        }
      }
    }
  } catch (err) {
    console.error("[campaigns] open track failed", err)
  }
  return pixelResponse()
}
