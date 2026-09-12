import "server-only"
import { query } from "@/lib/db"
import { ensureWhatsAppPlatformTables } from "@/lib/whatsapp-platform"
import { getWhatsAppIntegration, sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp"
import { assignConversation, recordOutboundMessage } from "@/lib/whatsapp-store"
import { setConversationDepartment } from "@/lib/whatsapp-routing"
import type { AutomationAction, AutomationTrigger } from "@/lib/whatsapp-config"

/**
 * Rule-based automation engine (chatbot-ready).
 *
 * Each rule pairs a trigger (welcome / keyword / new_conversation /
 * customer_requests_human) with an action (send template, send text, assign to
 * a department or agent, notify). `runInboundAutomations` is invoked from the
 * webhook after a customer message is recorded and fires every matching active
 * rule in priority order.
 */

let ensured = false

export async function ensureAutomationTables() {
  if (ensured) return
  await ensureWhatsAppPlatformTables()
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_automations\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(191) NOT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`trigger_type\` VARCHAR(48) NOT NULL,
      \`trigger_config_json\` TEXT DEFAULT NULL,
      \`action_type\` VARCHAR(48) NOT NULL,
      \`action_config_json\` TEXT DEFAULT NULL,
      \`department_id\` INT UNSIGNED DEFAULT NULL,
      \`priority\` INT NOT NULL DEFAULT 0,
      \`run_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`last_run_at\` DATETIME DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_automation_active\` (\`is_active\`),
      KEY \`idx_wa_automation_trigger\` (\`trigger_type\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

export type AutomationRow = {
  id: number
  name: string
  is_active: number
  trigger_type: string
  trigger_config_json: string | null
  action_type: string
  action_config_json: string | null
  department_id: number | null
  priority: number
  run_count: number
  last_run_at: string | null
  created_at: string
}

export type Automation = {
  id: number
  name: string
  isActive: boolean
  triggerType: string
  triggerConfig: Record<string, unknown>
  actionType: string
  actionConfig: Record<string, unknown>
  departmentId: number | null
  departmentName: string | null
  priority: number
  runCount: number
  lastRunAt: string | null
  createdAt: string
}

function parseJson(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

function toAutomation(r: AutomationRow & { department_name?: string | null }): Automation {
  return {
    id: r.id,
    name: r.name,
    isActive: r.is_active === 1,
    triggerType: r.trigger_type,
    triggerConfig: parseJson(r.trigger_config_json),
    actionType: r.action_type,
    actionConfig: parseJson(r.action_config_json),
    departmentId: r.department_id,
    departmentName: r.department_name ?? null,
    priority: r.priority,
    runCount: Number(r.run_count),
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
  }
}

export async function listAutomations(): Promise<Automation[]> {
  await ensureAutomationTables()
  const rows = await query<(AutomationRow & { department_name: string | null })[]>(
    `SELECT a.*, d.name AS department_name
       FROM \`marketing_whatsapp_automations\` a
       LEFT JOIN \`marketing_whatsapp_departments\` d ON d.id = a.department_id
      ORDER BY a.priority DESC, a.id ASC`,
  )
  return rows.map(toAutomation)
}

export async function createAutomation(input: {
  name: string
  triggerType: AutomationTrigger
  triggerConfig?: Record<string, unknown>
  actionType: AutomationAction
  actionConfig?: Record<string, unknown>
  departmentId?: number | null
  priority?: number
  createdBy: number | null
}): Promise<number> {
  await ensureAutomationTables()
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_whatsapp_automations\`
       (name, trigger_type, trigger_config_json, action_type, action_config_json, department_id, priority, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      input.triggerType,
      JSON.stringify(input.triggerConfig ?? {}),
      input.actionType,
      JSON.stringify(input.actionConfig ?? {}),
      input.departmentId ?? null,
      input.priority ?? 0,
      input.createdBy,
    ],
  )
  return result.insertId
}

export async function updateAutomation(
  id: number,
  patch: Partial<{
    name: string
    isActive: boolean
    triggerType: string
    triggerConfig: Record<string, unknown>
    actionType: string
    actionConfig: Record<string, unknown>
    departmentId: number | null
    priority: number
  }>,
): Promise<void> {
  await ensureAutomationTables()
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.name !== undefined) (sets.push("name = ?"), params.push(patch.name.trim()))
  if (patch.isActive !== undefined) (sets.push("is_active = ?"), params.push(patch.isActive ? 1 : 0))
  if (patch.triggerType !== undefined) (sets.push("trigger_type = ?"), params.push(patch.triggerType))
  if (patch.triggerConfig !== undefined) (sets.push("trigger_config_json = ?"), params.push(JSON.stringify(patch.triggerConfig)))
  if (patch.actionType !== undefined) (sets.push("action_type = ?"), params.push(patch.actionType))
  if (patch.actionConfig !== undefined) (sets.push("action_config_json = ?"), params.push(JSON.stringify(patch.actionConfig)))
  if (patch.departmentId !== undefined) (sets.push("department_id = ?"), params.push(patch.departmentId))
  if (patch.priority !== undefined) (sets.push("priority = ?"), params.push(patch.priority))
  if (!sets.length) return
  params.push(id)
  await query(`UPDATE \`marketing_whatsapp_automations\` SET ${sets.join(", ")} WHERE id = ?`, params)
}

export async function deleteAutomation(id: number): Promise<void> {
  await ensureAutomationTables()
  await query("DELETE FROM `marketing_whatsapp_automations` WHERE id = ?", [id])
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

const HUMAN_REQUEST_PATTERNS = [
  "talk to human",
  "speak to agent",
  "real person",
  "customer care",
  "customer support",
  "agent please",
  "human please",
  "call me",
]

export type InboundAutomationContext = {
  conversationId: number
  phone: string
  messageText: string
  isNewContact: boolean
  isNewConversation: boolean
  isAssigned: boolean
}

function triggerMatches(automation: Automation, ctx: InboundAutomationContext): boolean {
  const text = (ctx.messageText || "").toLowerCase()
  switch (automation.triggerType as AutomationTrigger) {
    case "welcome":
      return ctx.isNewContact
    case "new_conversation":
      return ctx.isNewConversation
    case "keyword": {
      const keywords = String((automation.triggerConfig.keywords as string) || "")
        .split(/[\n,]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
      return keywords.length > 0 && keywords.some((k) => text.includes(k))
    }
    case "customer_requests_human":
      return HUMAN_REQUEST_PATTERNS.some((p) => text.includes(p))
    default:
      return false
  }
}

async function runAction(automation: Automation, ctx: InboundAutomationContext): Promise<void> {
  const integration = await getWhatsAppIntegration()
  const cfg = automation.actionConfig

  switch (automation.actionType as AutomationAction) {
    case "send_template": {
      if (!integration) return
      const result = await sendWhatsAppTemplate({
        integration,
        to: ctx.phone,
        templateName: String(cfg.templateName || "hello_world"),
        languageCode: String(cfg.languageCode || "en_US"),
      })
      if (result.ok) {
        await recordOutboundMessage({
          conversationId: ctx.conversationId,
          wamid: result.messageId ?? null,
          messageType: "template",
          body: `[automation] ${String(cfg.templateName || "hello_world")}`,
          senderPhone: integration.display_phone_number?.replace(/[^\d]/g, "") ?? null,
          recipientPhone: ctx.phone,
          status: "sent",
          sentByUserId: null,
        })
      }
      break
    }
    case "send_text": {
      if (!integration) return
      const body = String(cfg.text || "").trim()
      if (!body) return
      // Inbound just arrived, so we're inside the 24h window.
      const result = await sendWhatsAppText({ integration, to: ctx.phone, body })
      if (result.ok) {
        await recordOutboundMessage({
          conversationId: ctx.conversationId,
          wamid: result.messageId ?? null,
          messageType: "text",
          body,
          senderPhone: integration.display_phone_number?.replace(/[^\d]/g, "") ?? null,
          recipientPhone: ctx.phone,
          status: "sent",
          sentByUserId: null,
        })
      }
      break
    }
    case "assign_department": {
      const deptId = automation.departmentId ?? Number(cfg.departmentId) || null
      if (deptId) await setConversationDepartment(ctx.conversationId, deptId)
      break
    }
    case "assign_agent": {
      const agentId = Number(cfg.agentId)
      if (Number.isInteger(agentId) && agentId > 0 && !ctx.isAssigned) {
        await assignConversation({
          conversationId: ctx.conversationId,
          agentId,
          team: null,
          byUserId: agentId,
          note: `Automation: ${automation.name}`,
        })
      }
      break
    }
    case "notify":
      // Best-effort: log only. ERP-wide notifications are wired elsewhere.
      console.log(`[v0] WhatsApp automation notify: ${automation.name} for conversation ${ctx.conversationId}`)
      break
  }
}

/** Fires every matching active automation for a fresh inbound message. */
export async function runInboundAutomations(ctx: InboundAutomationContext): Promise<number> {
  await ensureAutomationTables()
  const automations = await listAutomations()
  let fired = 0
  // Only one message-sending automation should fire to avoid spamming; the
  // first matching send wins, but routing/assign automations always run.
  let sentOne = false
  for (const a of automations) {
    if (!a.isActive) continue
    if (!triggerMatches(a, ctx)) continue
    const isSend = a.actionType === "send_template" || a.actionType === "send_text"
    if (isSend && sentOne) continue
    try {
      await runAction(a, ctx)
      if (isSend) sentOne = true
      await query(
        "UPDATE `marketing_whatsapp_automations` SET run_count = run_count + 1, last_run_at = NOW() WHERE id = ?",
        [a.id],
      )
      fired++
    } catch (err) {
      console.error(`[v0] automation ${a.id} failed:`, (err as Error).message)
    }
  }
  return fired
}
