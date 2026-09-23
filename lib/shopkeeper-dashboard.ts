import "server-only"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"

/**
 * Shopkeeper home screen. Every figure is scoped to the acting tenant and read
 * from that tenant's own rows — never aggregated across tenants.
 *
 * "Today" is evaluated in SQL against the server date, matching how the ERP
 * dashboards already report daily figures.
 */

export type ShopkeeperDashboard = {
  todayMessages: number
  unreadConversations: number
  todayOrders: number
  pendingOrders: number
  todaySales: number
  customerCount: number
  recentConversations: Array<{
    id: number
    contactName: string | null
    phone: string | null
    lastMessageAt: string | null
    preview: string | null
    unreadCount: number
  }>
  recentOrders: Array<{
    id: number
    orderNumber: string
    customerName: string | null
    total: number
    status: string
    paymentStatus: string
    createdAt: string
  }>
  whatsapp: { connected: boolean; phoneNumber: string | null; status: string | null }
}

async function scalar(sql: string, args: unknown[]): Promise<number> {
  try {
    const rows = await query<any[]>(sql, args)
    return Number(rows[0]?.value ?? 0)
  } catch {
    // A module the tenant has never opened may not have self-healed its table
    // yet; an absent table means zero activity, not a broken dashboard.
    return 0
  }
}

export async function getShopkeeperDashboard(): Promise<ShopkeeperDashboard> {
  const tenantId = currentTenantId()

  const [todayMessages, unreadConversations, todayOrders, pendingOrders, todaySales, customerCount] = await Promise.all([
    scalar(
      "SELECT COUNT(*) AS value FROM `marketing_whatsapp_messages` WHERE tenant_id = ? AND DATE(created_at) = CURDATE()",
      [tenantId],
    ),
    scalar(
      "SELECT COUNT(*) AS value FROM `marketing_whatsapp_conversations` WHERE tenant_id = ? AND unread_count > 0",
      [tenantId],
    ),
    scalar(
      "SELECT COUNT(*) AS value FROM `shopkeeper_orders` WHERE tenant_id = ? AND DATE(created_at) = CURDATE()",
      [tenantId],
    ),
    scalar(
      "SELECT COUNT(*) AS value FROM `shopkeeper_orders` WHERE tenant_id = ? AND status IN ('new','processing')",
      [tenantId],
    ),
    scalar(
      // Cancelled orders are excluded so the figure reflects money actually taken.
      "SELECT COALESCE(SUM(total),0) AS value FROM `shopkeeper_orders` WHERE tenant_id = ? AND status <> 'cancelled' AND DATE(created_at) = CURDATE()",
      [tenantId],
    ),
    scalar(
      "SELECT COUNT(*) AS value FROM `marketing_whatsapp_contacts` WHERE tenant_id = ? AND archived_at IS NULL",
      [tenantId],
    ),
  ])

  let recentConversations: ShopkeeperDashboard["recentConversations"] = []
  try {
    const rows = await query<any[]>(
      `SELECT c.id, c.last_message_at, c.last_message_preview, c.unread_count,
              ct.profile_name AS contact_name, ct.phone_number AS phone
         FROM \`marketing_whatsapp_conversations\` c
         LEFT JOIN \`marketing_whatsapp_contacts\` ct
           ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
        WHERE c.tenant_id = ?
        ORDER BY c.last_message_at DESC, c.id DESC
        LIMIT 10`,
      [tenantId],
    )
    recentConversations = rows.map((r) => ({
      id: Number(r.id),
      contactName: r.contact_name ?? null,
      phone: r.phone ?? null,
      lastMessageAt: r.last_message_at ?? null,
      preview: r.last_message_preview ?? null,
      unreadCount: Number(r.unread_count ?? 0),
    }))
  } catch {
    recentConversations = []
  }

  let recentOrders: ShopkeeperDashboard["recentOrders"] = []
  try {
    const rows = await query<any[]>(
      `SELECT id, order_number, customer_name, total, status, payment_status, created_at
         FROM \`shopkeeper_orders\`
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 10`,
      [tenantId],
    )
    recentOrders = rows.map((r) => ({
      id: Number(r.id),
      orderNumber: r.order_number,
      customerName: r.customer_name ?? null,
      total: Number(r.total),
      status: r.status,
      paymentStatus: r.payment_status,
      createdAt: r.created_at,
    }))
  } catch {
    recentOrders = []
  }

  let whatsapp: ShopkeeperDashboard["whatsapp"] = { connected: false, phoneNumber: null, status: null }
  try {
    // The integration table has no status column; a row with a phone number id
    // IS the connection, so presence is the signal.
    const rows = await query<any[]>(
      "SELECT display_phone_number, phone_number_id, quality_rating FROM `marketing_whatsapp_integration` WHERE tenant_id = ? AND released_at IS NULL LIMIT 1",
      [tenantId],
    )
    if (rows[0]) {
      whatsapp = {
        connected: Boolean(rows[0].phone_number_id),
        phoneNumber: rows[0].display_phone_number ?? null,
        status: rows[0].quality_rating ?? null,
      }
    }
  } catch {
    /* no integration row yet — reported as disconnected */
  }

  return {
    todayMessages,
    unreadConversations,
    todayOrders,
    pendingOrders,
    todaySales,
    customerCount,
    recentConversations,
    recentOrders,
    whatsapp,
  }
}
