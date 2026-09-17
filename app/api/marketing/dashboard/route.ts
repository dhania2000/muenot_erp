import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const num = (v: any) => Number(v ?? 0)

/**
 * Live marketing dashboard aggregates. Every query is defensive: a missing
 * table (module not yet provisioned on this install) resolves to zero rather
 * than failing the whole dashboard. The screen shows real numbers only.
 */
export async function GET() {
  // Any marketing viewer can see the overview. Contacts is the base feature
  // every marketing role is granted, so we gate on it.
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // --- KPI: contacts -------------------------------------------------------
  const [contacts] = await query<any[]>(
    `SELECT
        COUNT(*) AS total,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_30d,
        SUM(email_subscription = 'Subscribed') AS subscribed
      FROM marketing_contacts WHERE archived_at IS NULL`,
  ).catch(() => [{}])

  // --- KPI: journeys (campaigns) ------------------------------------------
  const [journeys] = await query<any[]>(
    `SELECT
        SUM(status = 'Active') AS active,
        SUM(status = 'Active' AND start_at IS NOT NULL AND start_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)) AS launching_week
      FROM marketing_journeys WHERE archived_at IS NULL`,
  ).catch(() => [{}])

  // --- KPI: email (sent + opens, last 30 days) -----------------------------
  const [emails] = await query<any[]>(
    `SELECT
        SUM(sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS sent_30d,
        SUM(sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND (open_count > 0 OR status = 'Opened')) AS opened_30d
      FROM sales_emails`,
  ).catch(() => [{}])

  // --- KPI: leads captured this quarter -----------------------------------
  const [leads] = await query<any[]>(
    `SELECT COUNT(*) AS captured
       FROM leadgen_submissions
      WHERE is_spam = 0 AND created_at >= MAKEDATE(YEAR(NOW()), 1) + INTERVAL (QUARTER(NOW()) - 1) QUARTER`,
  ).catch(() => [{}])

  const sent30 = num(emails?.sent_30d)
  const opened30 = num(emails?.opened_30d)
  const openRate = sent30 > 0 ? (opened30 / sent30) * 100 : 0

  // --- Campaign performance: sent vs opened, last 6 months -----------------
  const perfRows = await query<any[]>(
    `SELECT
        DATE_FORMAT(sent_at, '%Y-%m') AS ym,
        DATE_FORMAT(sent_at, '%b') AS month,
        COUNT(*) AS sent,
        SUM(open_count > 0 OR status = 'Opened') AS opened
      FROM sales_emails
      WHERE sent_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 5 MONTH)
      GROUP BY ym, month
      ORDER BY ym ASC`,
  ).catch(() => [])

  const performance = perfRows.map((r) => ({
    month: r.month,
    sent: num(r.sent),
    opened: num(r.opened),
  }))

  // --- Channel mix: outbound volume by channel -----------------------------
  const [emailVol] = await query<any[]>(
    `SELECT COUNT(*) AS n FROM sales_emails WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`,
  ).catch(() => [{}])
  const [waVol] = await query<any[]>(
    `SELECT COUNT(*) AS n FROM marketing_whatsapp_campaign_recipients
      WHERE status IN ('sent','delivered','read','replied') AND sent_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`,
  ).catch(() => [{}])
  const [socialVol] = await query<any[]>(
    `SELECT COUNT(*) AS n FROM marketing_social_posts
      WHERE status = 'published' AND published_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`,
  ).catch(() => [{}])

  const channelRaw = [
    { name: "Email", value: num(emailVol?.n) },
    { name: "WhatsApp", value: num(waVol?.n) },
    { name: "Social", value: num(socialVol?.n) },
  ]
  const channelTotal = channelRaw.reduce((s, c) => s + c.value, 0)
  const channels = channelRaw.map((c) => ({
    name: c.name,
    value: channelTotal > 0 ? Math.round((c.value / channelTotal) * 100) : 0,
    count: c.value,
  }))

  // --- Recent campaigns (journeys) with live enrollment counts -------------
  const recent = await query<any[]>(
    `SELECT
        j.name,
        j.trigger_type,
        j.status,
        COUNT(e.id) AS enrolled,
        SUM(e.goal_reached = 1) AS goals
      FROM marketing_journeys j
      LEFT JOIN marketing_journey_enrollments e ON e.journey_id = j.id
      WHERE j.archived_at IS NULL
      GROUP BY j.id
      ORDER BY j.updated_at DESC
      LIMIT 6`,
  ).catch(() => [])

  const recentCampaigns = recent.map((r) => {
    const enrolled = num(r.enrolled)
    const goals = num(r.goals)
    return {
      name: r.name,
      channel: r.trigger_type === "manual" ? "Automation" : String(r.trigger_type ?? "Automation"),
      status: r.status,
      enrolled,
      goalRate: enrolled > 0 ? `${((goals / enrolled) * 100).toFixed(1)}%` : "—",
    }
  })

  return NextResponse.json({
    kpis: {
      totalContacts: num(contacts?.total),
      newContacts30d: num(contacts?.new_30d),
      subscribed: num(contacts?.subscribed),
      activeCampaigns: num(journeys?.active),
      launchingThisWeek: num(journeys?.launching_week),
      emailsSent30d: sent30,
      openRate,
      leadsCaptured: num(leads?.captured),
    },
    performance,
    channels,
    recentCampaigns,
  })
}
