import { query } from "@/lib/db"
import { ensureEmailTables } from "@/lib/email"

// 1x1 transparent GIF — the smallest possible invisible image.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
)

function pixelResponse() {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // Prevent the mail client / proxies from caching the pixel so every
      // open triggers a fresh request and increments the count.
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  })
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // Always return the pixel, even on error — the recipient must never notice
  // anything unusual. Tracking failures are silent.
  try {
    await ensureEmailTables()
    const rows = await query<any[]>(
      `SELECT id FROM sales_emails WHERE tracking_token = ? LIMIT 1`,
      [token],
    )
    const email = rows[0]
    if (email) {
      const userAgent = request.headers.get("user-agent")?.slice(0, 400) || null
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        null

      // Increment the open count and update timestamps on every open.
      await query(
        `UPDATE sales_emails
         SET open_count = open_count + 1,
             status = 'Opened',
             first_opened_at = COALESCE(first_opened_at, NOW()),
             last_opened_at = NOW()
         WHERE id = ?`,
        [email.id],
      )
      // Log each individual open as an activity event.
      await query(
        `INSERT INTO sales_email_events (email_id, event_type, user_agent, ip_address)
         VALUES (?, 'open', ?, ?)`,
        [email.id, userAgent, ip],
      )
    }
  } catch {
    // swallow — never leak tracking to the recipient
  }

  return pixelResponse()
}
