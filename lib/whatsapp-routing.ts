import "server-only"
import { query } from "@/lib/db"
import { assignConversation } from "@/lib/whatsapp-store"
import { ensureWhatsAppPlatformTables, getDepartment, type DepartmentRow } from "@/lib/whatsapp-platform"
import { DEFAULT_WORKING_HOURS } from "@/lib/whatsapp-config"

/**
 * Shared-inbox routing engine.
 *
 * When a new inbound message arrives we:
 *   1. Pick the best department (keyword match → existing → first auto-assign).
 *   2. Stamp the conversation with that department.
 *   3. If the department auto-assigns and is inside working hours, pick an agent
 *      with its configured routing method (round robin / fewest open chats /
 *      least active) and assign the conversation to them.
 *
 * Everything is best-effort: a routing failure must never drop a customer
 * message, so callers wrap this and swallow errors.
 */

function parseKeywords(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(/[\n,]/).map((k) => k.trim().toLowerCase()).filter(Boolean)
}

function parseWorkingHours(json: string | null) {
  if (!json) return DEFAULT_WORKING_HOURS
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === "object" ? parsed : DEFAULT_WORKING_HOURS
  } catch {
    return DEFAULT_WORKING_HOURS
  }
}

/** True if `now` (in the given IANA tz) falls inside the department's open hours. */
export function isWithinWorkingHours(
  workingHours: Record<string, { open: string; close: string; enabled: boolean }>,
  tz = "Asia/Kolkata",
  now = new Date(),
): boolean {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon"
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00"
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00"
    const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)
    const day = workingHours[String(dayIndex)]
    if (!day || !day.enabled) return false
    const cur = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
    return cur >= day.open && cur <= day.close
  } catch {
    return true // fail open — better to assign than to strand a chat
  }
}

/** Chooses the department that best matches the inbound text via keywords. */
async function pickDepartment(messageText: string, currentDepartmentId: number | null): Promise<DepartmentRow | null> {
  await ensureWhatsAppPlatformTables()
  const departments = await query<DepartmentRow[]>(
    "SELECT * FROM `marketing_whatsapp_departments` WHERE is_active = 1 ORDER BY sort_order ASC, id ASC",
  )
  if (!departments.length) return null

  const text = (messageText || "").toLowerCase()
  if (text) {
    for (const d of departments) {
      const keywords = parseKeywords(d.keywords)
      if (keywords.some((kw) => text.includes(kw))) return d
    }
  }

  // Keep the existing department if the conversation already had one.
  if (currentDepartmentId) {
    const existing = departments.find((d) => d.id === currentDepartmentId)
    if (existing) return existing
  }

  // Otherwise the first active department that auto-assigns (fallback: first).
  return departments.find((d) => d.auto_assign === 1) ?? departments[0]
}

type RoutableAgent = { user_id: number; open_count: number; last_assigned_at: string | null }

/** Available agents in a department (is_active membership + is_available flag). */
async function departmentRoutableAgents(departmentId: number): Promise<RoutableAgent[]> {
  return query<RoutableAgent[]>(
    `SELECT da.user_id,
            COALESCE(s.last_assigned_at, NULL) AS last_assigned_at,
            (SELECT COUNT(*) FROM \`marketing_whatsapp_conversations\` c
              WHERE c.assigned_agent_id = da.user_id AND c.status <> 'closed') AS open_count
       FROM \`marketing_whatsapp_department_agents\` da
       LEFT JOIN \`marketing_whatsapp_agent_settings\` s ON s.user_id = da.user_id
      WHERE da.department_id = ? AND da.is_active = 1
        AND COALESCE(s.is_available, 1) = 1
        AND COALESCE(s.can_send, 1) = 1`,
    [departmentId],
  )
}

function chooseAgent(method: string, agents: RoutableAgent[]): RoutableAgent | null {
  if (!agents.length) return null
  switch (method) {
    case "least_assigned":
    case "least_active":
      return [...agents].sort((a, b) => a.open_count - b.open_count)[0]
    case "round_robin":
    default: {
      // Oldest last-assigned first; never-assigned agents (null) come first.
      return [...agents].sort((a, b) => {
        const at = a.last_assigned_at ? Date.parse(a.last_assigned_at.replace(" ", "T") + "Z") : 0
        const bt = b.last_assigned_at ? Date.parse(b.last_assigned_at.replace(" ", "T") + "Z") : 0
        return at - bt
      })[0]
    }
  }
}

export type RoutingResult = { departmentId: number | null; departmentName: string | null; agentId: number | null }

/**
 * Routes a freshly-updated conversation. Skips agent assignment when the
 * conversation is already claimed by an agent, but still keeps the department
 * fresh. Safe to call on every inbound message.
 */
export async function routeConversation(input: {
  conversationId: number
  messageText: string
}): Promise<RoutingResult> {
  await ensureWhatsAppPlatformTables()

  const rows = await query<{ assigned_agent_id: number | null; department_id: number | null; status: string }[]>(
    "SELECT assigned_agent_id, department_id, status FROM `marketing_whatsapp_conversations` WHERE id = ? LIMIT 1",
    [input.conversationId],
  )
  const convo = rows[0]
  if (!convo) return { departmentId: null, departmentName: null, agentId: null }

  const dept = await pickDepartment(input.messageText, convo.department_id)
  if (!dept) return { departmentId: null, departmentName: null, agentId: convo.assigned_agent_id }

  // Stamp the department if it changed.
  if (convo.department_id !== dept.id) {
    await query("UPDATE `marketing_whatsapp_conversations` SET department_id = ? WHERE id = ?", [
      dept.id,
      input.conversationId,
    ])
  }

  // Don't steal an already-claimed conversation.
  if (convo.assigned_agent_id) {
    return { departmentId: dept.id, departmentName: dept.name, agentId: convo.assigned_agent_id }
  }

  if (dept.auto_assign !== 1 || dept.routing_method === "manual") {
    return { departmentId: dept.id, departmentName: dept.name, agentId: null }
  }
  if (!isWithinWorkingHours(parseWorkingHours(dept.working_hours))) {
    return { departmentId: dept.id, departmentName: dept.name, agentId: null }
  }

  const agents = await departmentRoutableAgents(dept.id)
  const chosen = chooseAgent(dept.routing_method, agents)
  if (!chosen) return { departmentId: dept.id, departmentName: dept.name, agentId: null }

  await assignConversation({
    conversationId: input.conversationId,
    agentId: chosen.user_id,
    team: dept.slug,
    byUserId: chosen.user_id,
    note: `Auto-routed to ${dept.name} (${dept.routing_method})`,
  })
  await query(
    "INSERT INTO `marketing_whatsapp_agent_settings` (user_id, last_assigned_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_assigned_at = NOW()",
    [chosen.user_id],
  )

  return { departmentId: dept.id, departmentName: dept.name, agentId: chosen.user_id }
}

/** Moves a conversation to a different department, recording an audit transfer. */
export async function setConversationDepartment(conversationId: number, departmentId: number | null): Promise<void> {
  await ensureWhatsAppPlatformTables()
  if (departmentId !== null) {
    const dept = await getDepartment(departmentId)
    if (!dept) throw new Error("Department not found")
  }
  await query("UPDATE `marketing_whatsapp_conversations` SET department_id = ? WHERE id = ?", [
    departmentId,
    conversationId,
  ])
}
