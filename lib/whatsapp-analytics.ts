import "server-only"
import { query } from "@/lib/db"
import { ensureWhatsAppPlatformTables } from "@/lib/whatsapp-platform"

/**
 * Read-only analytics aggregations for the WhatsApp platform. Everything is
 * derived from the existing messaging + platform tables so there is no separate
 * analytics store to keep in sync.
 */

export type WhatsAppAnalytics = {
  totals: {
    contacts: number
    optedInContacts: number
    openConversations: number
    closedConversations: number
    unassigned: number
    unread: number
    inbound7d: number
    outbound7d: number
    campaigns: number
    activeAutomations: number
  }
  avgFirstResponseMinutes: number | null
  daily: { date: string; inbound: number; outbound: number }[]
  departments: { id: number; name: string; open: number; agents: number }[]
  agents: { userId: number; name: string; open: number; closed7d: number; sent7d: number }[]
  campaigns: {
    id: number
    name: string
    status: string
    total: number
    sent: number
    delivered: number
    read: number
    failed: number
    replied: number
  }[]
}

export async function getWhatsAppAnalytics(): Promise<WhatsAppAnalytics> {
  await ensureWhatsAppPlatformTables()

  const [
    contactRows,
    convoRows,
    msgRows,
    frtRows,
    dailyRows,
    deptRows,
    agentRows,
    campaignRows,
    automationRows,
  ] = await Promise.all([
    query<{ total: number; opted: number }[]>(
      "SELECT COUNT(*) AS total, SUM(opted_in = 1) AS opted FROM `marketing_whatsapp_contacts`",
    ),
    query<{ open_count: number; closed_count: number; unassigned: number; unread: number }[]>(
      `SELECT
         SUM(status <> 'closed') AS open_count,
         SUM(status = 'closed') AS closed_count,
         SUM(status <> 'closed' AND assigned_agent_id IS NULL) AS unassigned,
         SUM(unread_count) AS unread
       FROM \`marketing_whatsapp_conversations\``,
    ),
    query<{ inbound: number; outbound: number }[]>(
      `SELECT
         SUM(direction = 'inbound') AS inbound,
         SUM(direction = 'outbound') AS outbound
       FROM \`marketing_whatsapp_messages\`
      WHERE created_at >= (NOW() - INTERVAL 7 DAY)`,
    ),
    query<{ avg_minutes: number | null }[]>(
      `SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) AS avg_minutes
         FROM \`marketing_whatsapp_conversations\`
        WHERE first_response_at IS NOT NULL`,
    ),
    query<{ d: string; inbound: number; outbound: number }[]>(
      `SELECT DATE(created_at) AS d,
              SUM(direction = 'inbound') AS inbound,
              SUM(direction = 'outbound') AS outbound
         FROM \`marketing_whatsapp_messages\`
        WHERE created_at >= (NOW() - INTERVAL 14 DAY)
        GROUP BY DATE(created_at)
        ORDER BY d ASC`,
    ),
    query<{ id: number; name: string; open_count: number; agent_count: number }[]>(
      `SELECT d.id, d.name,
              (SELECT COUNT(*) FROM \`marketing_whatsapp_conversations\` c WHERE c.department_id = d.id AND c.status <> 'closed') AS open_count,
              (SELECT COUNT(*) FROM \`marketing_whatsapp_department_agents\` da WHERE da.department_id = d.id AND da.is_active = 1) AS agent_count
         FROM \`marketing_whatsapp_departments\` d
        WHERE d.is_active = 1
        ORDER BY d.sort_order ASC`,
    ),
    query<{ user_id: number; name: string; open_count: number; closed7d: number; sent7d: number }[]>(
      `SELECT u.id AS user_id, u.name,
              (SELECT COUNT(*) FROM \`marketing_whatsapp_conversations\` c WHERE c.assigned_agent_id = u.id AND c.status <> 'closed') AS open_count,
              (SELECT COUNT(*) FROM \`marketing_whatsapp_conversations\` c WHERE c.closed_by = u.id AND c.closed_at >= (NOW() - INTERVAL 7 DAY)) AS closed7d,
              (SELECT COUNT(*) FROM \`marketing_whatsapp_messages\` m WHERE m.sent_by_user_id = u.id AND m.created_at >= (NOW() - INTERVAL 7 DAY)) AS sent7d
         FROM \`users\` u
         JOIN \`marketing_whatsapp_agent_settings\` s ON s.user_id = u.id AND s.is_agent = 1
        ORDER BY open_count DESC, u.name ASC
        LIMIT 50`,
    ),
    query<
      { id: number; name: string; status: string; total_recipients: number; sent_count: number; delivered_count: number; read_count: number; failed_count: number; replied_count: number }[]
    >(
      `SELECT id, name, status, total_recipients, sent_count, delivered_count, read_count, failed_count, replied_count
         FROM \`marketing_whatsapp_campaigns\`
        ORDER BY created_at DESC LIMIT 20`,
    ).catch(() => []),
    query<{ c: number }[]>(
      "SELECT COUNT(*) AS c FROM `marketing_whatsapp_automations` WHERE is_active = 1",
    ).catch(() => [{ c: 0 }]),
  ])

  const contacts = contactRows[0] ?? { total: 0, opted: 0 }
  const convo = convoRows[0] ?? { open_count: 0, closed_count: 0, unassigned: 0, unread: 0 }
  const msg = msgRows[0] ?? { inbound: 0, outbound: 0 }

  // Backfill the last 14 days so the chart has no gaps.
  const dailyMap = new Map(dailyRows.map((r) => [r.d, r]))
  const daily: { date: string; inbound: number; outbound: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const row = dailyMap.get(key)
    daily.push({ date: key, inbound: Number(row?.inbound ?? 0), outbound: Number(row?.outbound ?? 0) })
  }

  return {
    totals: {
      contacts: Number(contacts.total ?? 0),
      optedInContacts: Number(contacts.opted ?? 0),
      openConversations: Number(convo.open_count ?? 0),
      closedConversations: Number(convo.closed_count ?? 0),
      unassigned: Number(convo.unassigned ?? 0),
      unread: Number(convo.unread ?? 0),
      inbound7d: Number(msg.inbound ?? 0),
      outbound7d: Number(msg.outbound ?? 0),
      campaigns: campaignRows.length,
      activeAutomations: Number(automationRows[0]?.c ?? 0),
    },
    avgFirstResponseMinutes: frtRows[0]?.avg_minutes != null ? Math.round(Number(frtRows[0].avg_minutes)) : null,
    daily,
    departments: deptRows.map((d) => ({ id: d.id, name: d.name, open: Number(d.open_count), agents: Number(d.agent_count) })),
    agents: agentRows.map((a) => ({
      userId: a.user_id,
      name: a.name,
      open: Number(a.open_count),
      closed7d: Number(a.closed7d),
      sent7d: Number(a.sent7d),
    })),
    campaigns: campaignRows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      total: Number(c.total_recipients),
      sent: Number(c.sent_count),
      delivered: Number(c.delivered_count),
      read: Number(c.read_count),
      failed: Number(c.failed_count),
      replied: Number(c.replied_count),
    })),
  }
}
