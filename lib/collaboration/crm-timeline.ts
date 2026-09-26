import "server-only"
/**
 * Spec42 (#191-192) — module communications → unified CRM timeline.
 * ---------------------------------------------------------------------------
 * The existing modules (sales calls, sales emails + scheduler, sales meetings,
 * manual lead activities, WhatsApp inbox) already funnel lead events through
 * `attachLeadEvent` / the WhatsApp message store. This connector mirrors those
 * writes into the ONE `activity_events` stream under subject_type "lead", so
 * the record activity panel and /api/collaboration/[type]/[id] show them next
 * to comments. It never creates a parallel store.
 *
 * Tenant safety: a lead is resolved with a tenant predicate whenever a tenant
 * is in context; system callers (cron) derive the owning tenant from the lead
 * and the write runs bound to that tenant. A lead id from another tenant
 * resolves to null and nothing is written.
 */

import { query } from "@/lib/db"
import { recordActivitySafe, type RecordedActivity } from "@/lib/activity/db"
import { currentTenantIdOrNull, runForTenant } from "@/lib/tenant-scope"
import { CRM_DIRECTIONS, type CrmChannel, leadTimelineDedupeKey } from "./model"

export type LeadRef = { tenantId: number; id: number; label: string }
type Direction = (typeof CRM_DIRECTIONS)[number]

function toLeadRef(row: any): LeadRef | null {
  if (!row || row.tenant_id == null) return null
  const label = String(row.company_name ?? "").trim()
  return { tenantId: Number(row.tenant_id), id: Number(row.id), label: label || `#${row.id}` }
}

export async function resolveLeadForTimeline(leadId: number): Promise<LeadRef | null> {
  if (!Number.isSafeInteger(leadId) || leadId < 1) return null
  const tenantId = currentTenantIdOrNull()
  const rows =
    tenantId != null
      ? await query<any[]>(`SELECT id, tenant_id, company_name FROM sales_leads WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenantId, leadId])
      : await query<any[]>(`SELECT id, tenant_id, company_name FROM sales_leads WHERE id = ? LIMIT 1`, [leadId])
  return toLeadRef(rows[0])
}

export type LeadCommunication = {
  channel: CrmChannel
  title: string
  body?: string | null
  direction?: Direction | null
  refType?: string | null
  refId?: string | number | null
  actorId?: number | null
  occurredAt?: string | Date | null
  idempotencyKey?: string | null
}

function defaultDirection(channel: CrmChannel): Direction {
  return channel === "note" || channel === "meeting" ? "internal" : "outbound"
}

/** Fire-and-forget: a timeline failure never rolls back the module's real write. */
export async function mirrorLeadCommunication(lead: LeadRef, e: LeadCommunication): Promise<RecordedActivity | null> {
  const direction = e.direction && (CRM_DIRECTIONS as readonly string[]).includes(e.direction) ? e.direction : defaultDirection(e.channel)
  const title = (e.title || e.channel).trim().slice(0, 200) || e.channel
  const dedupeKey = leadTimelineDedupeKey({ channel: e.channel, refType: e.refType, refId: e.refId, idempotencyKey: e.idempotencyKey })
  return runForTenant({ tenantId: lead.tenantId }, () =>
    recordActivitySafe(
      {
        kind: e.channel,
        subject_type: "lead",
        subject_id: lead.id,
        subject_label: lead.label,
        action: e.channel === "note" ? "noted" : direction,
        title,
        body: e.body ? String(e.body).slice(0, 10000) : null,
        source_module: "crm",
        actor_id: e.actorId ?? null,
        occurred_at: e.occurredAt ?? null,
        ref_type: e.refType ?? null,
        ref_id: e.refId ?? null,
        meta: { direction, sourceRef: e.refId != null ? `${e.refType || e.channel}/${e.refId}` : null, origin: "module" },
      },
      dedupeKey ? { dedupeKey } : undefined,
    ),
  )
}

/**
 * Mirror a stored WhatsApp message onto the linked lead's timeline (if the
 * conversation's contact is linked to a lead in the same tenant). Deduped on
 * the provider wamid, so duplicate webhook deliveries never double-post.
 */
export async function mirrorWhatsAppMessage(input: {
  conversationId: number
  direction: "inbound" | "outbound"
  wamid: string | null
  messageId?: number | null
  messageType: string
  body: string | null
  actorId?: number | null
  occurredAt?: Date | null
}): Promise<RecordedActivity | null> {
  const tenantId = currentTenantIdOrNull()
  if (tenantId == null) return null
  const rows = await query<any[]>(
    `SELECT l.id, l.tenant_id, l.company_name
       FROM marketing_whatsapp_conversations cv
       JOIN marketing_whatsapp_contacts ct ON ct.id = cv.contact_id AND ct.tenant_id = cv.tenant_id
       JOIN sales_leads l ON l.id = ct.lead_id AND l.tenant_id = cv.tenant_id
      WHERE cv.tenant_id = ? AND cv.id = ? LIMIT 1`,
    [tenantId, input.conversationId],
  )
  const lead = toLeadRef(rows[0])
  if (!lead) return null
  const refId = input.wamid || (input.messageId ? `msg-${input.messageId}` : null)
  const text = input.body?.trim() || `[${input.messageType || "message"}]`
  return mirrorLeadCommunication(lead, {
    channel: "whatsapp",
    title: input.direction === "inbound" ? "WhatsApp message received" : "WhatsApp message sent",
    body: text,
    direction: input.direction,
    refType: "whatsapp",
    refId,
    actorId: input.direction === "outbound" ? input.actorId ?? null : null,
    occurredAt: input.occurredAt ?? null,
  })
}
