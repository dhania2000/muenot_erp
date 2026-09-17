import { query } from "@/lib/db"
import { recordContactActivity } from "@/lib/marketing/contacts-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function page(title: string, message: string, ok = true): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f8fafc;color:#0f172a;}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;max-width:440px;width:100%;padding:40px 32px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .badge{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;font-size:28px;background:${ok ? "#ecfdf5" : "#fef2f2"};color:${ok ? "#059669" : "#dc2626"};}
  h1{font-size:20px;margin:0 0 10px;}
  p{font-size:14px;line-height:1.6;color:#475569;margin:0;}
</style></head><body><div class="wrap"><div class="card">
  <div class="badge">${ok ? "&#10003;" : "!"}</div>
  <h1>${title}</h1><p>${message}</p>
</div></div></body></html>`
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
}

async function processUnsubscribe(token: string): Promise<boolean> {
  if (!token || token.startsWith("test-")) return false
  const rows = await query<any[]>(
    `SELECT id, campaign_id, contact_id, contact_code, email, unsubscribed_at FROM marketing_campaign_recipients WHERE unsubscribe_token = ? LIMIT 1`,
    [token],
  )
  const r = rows[0]
  if (!r) return false

  await query(
    `UPDATE marketing_campaign_recipients
        SET status = 'Unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE id = ?`,
    [r.id],
  )
  await query(`INSERT INTO marketing_campaign_events (campaign_id, recipient_id, event_type) VALUES (?,?,'unsubscribe')`, [
    r.campaign_id,
    r.id,
  ])

  // Global opt-out on the contact master so future campaigns exclude them.
  if (r.contact_id) {
    await query(
      `UPDATE marketing_contacts SET email_subscription = 'Unsubscribed', unsubscribed_at = NOW() WHERE id = ?`,
      [r.contact_id],
    ).catch(async () => {
      // unsubscribed_at may not exist on older contact tables — fall back.
      await query(`UPDATE marketing_contacts SET email_subscription = 'Unsubscribed' WHERE id = ?`, [r.contact_id]).catch(() => {})
    })
    await recordContactActivity({
      contactId: Number(r.contact_id),
      contactCode: r.contact_code,
      type: "consent",
      summary: "Unsubscribed from marketing emails",
      meta: { campaign_id: r.campaign_id, source: "campaign_footer" },
    }).catch(() => {})
  }
  return true
}

/** One-click unsubscribe (also satisfies List-Unsubscribe GET). */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const done = await processUnsubscribe(token)
    if (!done) return page("Link expired", "This unsubscribe link is no longer valid. If you continue to receive emails, reply and let us know.", false)
    return page("You've been unsubscribed", "You will no longer receive marketing emails from us. It may take a moment to take effect across all campaigns.")
  } catch (err) {
    console.error("[campaigns] unsubscribe failed", err)
    return page("Something went wrong", "We couldn't process your request. Please try again later.", false)
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  return GET(request, ctx)
}
