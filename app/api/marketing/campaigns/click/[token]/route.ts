import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { recordContactActivity } from "@/lib/marketing/contacts-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Click redirect: record the click, then 302 to the real destination. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const url = new URL(request.url)
  const target = url.searchParams.get("u")

  // Validate the destination before doing anything else.
  let safeTarget = "/"
  try {
    if (target) {
      const parsed = new URL(target)
      if (parsed.protocol === "http:" || parsed.protocol === "https:") safeTarget = parsed.toString()
    }
  } catch {
    safeTarget = "/"
  }

  try {
    const { token } = await params
    if (token && !token.startsWith("test-") && target) {
      const rows = await query<any[]>(
        `SELECT id, campaign_id, contact_id, contact_code, click_count FROM marketing_campaign_recipients WHERE tracking_token = ? LIMIT 1`,
        [token],
      )
      const r = rows[0]
      if (r) {
        const ua = request.headers.get("user-agent")?.slice(0, 400) || null
        const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim().slice(0, 64) || null
        await query(
          `UPDATE marketing_campaign_recipients
              SET click_count = click_count + 1,
                  open_count = GREATEST(open_count, 1),
                  first_clicked_at = COALESCE(first_clicked_at, NOW()),
                  last_clicked_at = NOW(),
                  first_opened_at = COALESCE(first_opened_at, NOW()),
                  status = CASE WHEN status IN ('Sent','Delivered','Opened') THEN 'Clicked' ELSE status END
            WHERE id = ?`,
          [r.id],
        )
        await query(
          `INSERT INTO marketing_campaign_events (campaign_id, recipient_id, event_type, url, user_agent, ip_address) VALUES (?,?,'click',?,?,?)`,
          [r.campaign_id, r.id, safeTarget.slice(0, 1000), ua, ip],
        )
        if (Number(r.click_count || 0) === 0 && r.contact_id) {
          await recordContactActivity({
            contactId: Number(r.contact_id),
            contactCode: r.contact_code,
            type: "campaign",
            summary: `Clicked a link in a campaign email`,
            meta: { campaign_id: r.campaign_id, url: safeTarget },
          }).catch(() => {})
        }
      }
    }
  } catch (err) {
    console.error("[campaigns] click track failed", err)
  }

  return NextResponse.redirect(safeTarget, 302)
}
