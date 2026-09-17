import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema } from "@/lib/marketing/contacts-db"

const num = (v: any) => Number(v ?? 0)

export async function GET() {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const base = "FROM marketing_contacts WHERE archived_at IS NULL"

  const [totals] = await query<any[]>(
    `SELECT
        COUNT(*) AS total,
        SUM(status = 'Active') AS active,
        SUM(email_subscription = 'Subscribed') AS subscribed,
        SUM(email_subscription = 'Unsubscribed') AS unsubscribed,
        SUM(email_subscription = 'Pending') AS pending,
        SUM(deliverability = 'Bounced') AS bounced,
        SUM(consent = 1) AS consented,
        SUM(email IS NOT NULL AND email <> '' AND status = 'Active' AND email_subscription = 'Subscribed' AND deliverability NOT IN ('Bounced','Complained')) AS email_eligible
      ${base}`,
  ).catch(() => [{}])

  const byStage = await query<any[]>(
    `SELECT lifecycle_stage AS stage, COUNT(*) AS count ${base} GROUP BY lifecycle_stage ORDER BY count DESC`,
  ).catch(() => [])
  const bySource = await query<any[]>(
    `SELECT source, COUNT(*) AS count ${base} GROUP BY source ORDER BY count DESC`,
  ).catch(() => [])

  const [growth] = await query<any[]>(
    `SELECT
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS last_30_days,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last_7_days
      ${base}`,
  ).catch(() => [{}])

  return NextResponse.json({
    totals: {
      total: num(totals?.total),
      active: num(totals?.active),
      subscribed: num(totals?.subscribed),
      unsubscribed: num(totals?.unsubscribed),
      pending: num(totals?.pending),
      bounced: num(totals?.bounced),
      consented: num(totals?.consented),
      email_eligible: num(totals?.email_eligible),
    },
    growth: { last_30_days: num(growth?.last_30_days), last_7_days: num(growth?.last_7_days) },
    byStage,
    bySource,
  })
}
