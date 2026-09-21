import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { enqueueEmailJob } from "@/lib/background-jobs"
import { buildMessageId } from "@/lib/email"
import { type EmailModule, type EmailRequest, trackingToken, validateEmailRequest } from "./model"
import { ensureEmailEngineSchema } from "./schema"

type Sender = { id: number; from_name: string | null; from_address: string | null; reply_to: string | null; transport_department: "sales" | "hr" | "finance" | "operations" | "recruit" }

function keyFor(to: string) { return crypto.createHash("sha256").update(to).digest("hex").slice(0, 48) }
function asJson(value: unknown) { return value == null ? null : JSON.stringify(value) }
function withTrackingPixel(html: string, token: string | null) {
  if (!token) return html
  const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")
  if (!/^https:\/\//i.test(base)) return html
  return `${html}<img src="${base}/api/email/track/${token}" width="1" height="1" alt="" style="display:none" />`
}

async function resolveSender(tenantId: number, module: EmailModule): Promise<Sender | null> {
  const rows = await query<any[]>("SELECT id,from_name,from_address,reply_to,transport_department FROM tenant_email_senders WHERE tenant_id=? AND module IN (?, 'system') AND enabled=1 ORDER BY module=? DESC,id DESC LIMIT 1", [tenantId, module, module])
  return rows[0] ?? null
}

export async function queueTenantEmail(raw: EmailRequest) {
  const input = validateEmailRequest(raw)
  await ensureEmailEngineSchema()
  const sender = await resolveSender(input.tenantId, input.module)
  const threadKey = keyFor(input.to)
  let prior: any = null
  if (input.replyToMessageId) {
    const rows = await query<any[]>("SELECT id,thread_key,message_id,provider_thread_id,references_header,subject FROM tenant_email_messages WHERE tenant_id=? AND id=? AND status IN ('accepted','delivered') LIMIT 1", [input.tenantId, input.replyToMessageId])
    prior = rows[0]
    if (!prior) throw new Error("The selected reply email is unavailable")
  }
  const token = input.trackingConsent ? trackingToken() : null
  const html = withTrackingPixel(input.html, token)
  const messageId = buildMessageId(token ?? crypto.randomUUID(), (sender?.transport_department ?? "sales"))
  const subject = prior ? `Re: ${String(prior.subject).replace(/^(\s*re:\s*)+/i, "").trim()}` : input.subject
  const insert = await query<any>(`INSERT INTO tenant_email_messages
    (tenant_id,module,template_id,sender_id,to_email,to_name,subject,html,thread_key,in_reply_to_message_id,message_id,provider_thread_id,references_header,attachments_json,tracking_token,tracking_consent,sent_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [input.tenantId,input.module,input.templateId ?? null,sender?.id ?? null,input.to,input.toName ?? null,subject,html,prior?.thread_key ?? threadKey,input.replyToMessageId ?? null,messageId,prior?.provider_thread_id ?? null,prior?.references_header ? `${prior.references_header} ${prior.message_id}` : prior?.message_id ?? null,asJson(input.attachments ?? []),token,Boolean(input.trackingConsent),input.actorId ?? null])
  const id = Number(insert.insertId)
  const job = await enqueueEmailJob({ tenantId: input.tenantId, createdBy: input.actorId ?? null, triggerSource: "system", idempotencyKey: input.idempotencyKey ?? `tenant-email:${id}`, concurrencyKey: `tenant-email:${input.tenantId}:${input.module}`, payload: { to: input.to, subject, html, from: sender?.from_address ?? undefined, department: sender?.transport_department ?? "sales", headers: { "X-Muenot-Email-Message": String(id) }, engineMessageId: id, messageId, inReplyTo: prior?.message_id ?? undefined, references: prior?.references_header ? `${prior.references_header} ${prior.message_id}` : prior?.message_id ?? undefined, providerThreadId: prior?.provider_thread_id ?? undefined, attachmentPaths: (input.attachments ?? []).map((a) => a.pathname) } })
  await query("UPDATE tenant_email_messages SET job_id=? WHERE tenant_id=? AND id=?", [job.id, input.tenantId, id])
  await query("INSERT INTO tenant_email_events (tenant_id,message_id,event_type,detail) VALUES (?,?,?,?)", [input.tenantId,id,"queued",asJson({ jobId: job.id, module: input.module })])
  return { id, jobId: job.id, trackingToken: token }
}

/** Called only by the reviewed queue worker after the provider accepts a message. */
export async function markTenantEmailAccepted(messageId: number, result: { messageId?: string; providerThreadId?: string | null }) {
  await ensureEmailEngineSchema()
  const rows = await query<any[]>("SELECT tenant_id FROM tenant_email_messages WHERE id=? LIMIT 1", [messageId])
  const tenantId = Number(rows[0]?.tenant_id)
  if (!tenantId) return
  await query("UPDATE tenant_email_messages SET status='accepted',attempts=attempts+1,provider_message_id=?,provider_thread_id=COALESCE(?,provider_thread_id),accepted_at=UTC_TIMESTAMP(),last_error=NULL WHERE tenant_id=? AND id=? AND status IN ('queued','sending')", [result.messageId ?? null,result.providerThreadId ?? null,tenantId,messageId])
  await query("INSERT INTO tenant_email_events (tenant_id,message_id,event_type,detail) VALUES (?,?,?,?)", [tenantId,messageId,"accepted",asJson(result)])
}

export async function markTenantEmailFailed(messageId: number, error: unknown) {
  await ensureEmailEngineSchema()
  const rows = await query<any[]>("SELECT tenant_id FROM tenant_email_messages WHERE id=? LIMIT 1", [messageId])
  const tenantId = Number(rows[0]?.tenant_id)
  if (!tenantId) return
  const detail = error instanceof Error ? error.message : "Email provider rejected delivery"
  await query("UPDATE tenant_email_messages SET status='failed',attempts=attempts+1,last_error=? WHERE tenant_id=? AND id=? AND status IN ('queued','sending')", [detail.slice(0,1000),tenantId,messageId])
  await query("INSERT INTO tenant_email_events (tenant_id,message_id,event_type,detail) VALUES (?,?,?,?)", [tenantId,messageId,"failed",asJson({ error: detail.slice(0,1000) })])
}

export async function trackTenantEmail(token: string, event: "open" | "click") {
  await ensureEmailEngineSchema()
  const rows = await query<any[]>("SELECT id,tenant_id,tracking_consent FROM tenant_email_messages WHERE tracking_token=? LIMIT 1", [token])
  const row = rows[0]
  if (!row || !row.tracking_consent) return false
  const field = event === "open" ? "open" : "click"
  await query(`UPDATE tenant_email_messages SET ${field}_count=${field}_count+1,${field}ed_at=COALESCE(${field}ed_at,UTC_TIMESTAMP()) WHERE tenant_id=? AND id=?`, [row.tenant_id,row.id])
  await query("INSERT INTO tenant_email_events (tenant_id,message_id,event_type) VALUES (?,?,?)", [row.tenant_id,row.id,event])
  return true
}

export async function listTenantEmails(tenantId: number, limit = 100) {
  await ensureEmailEngineSchema()
  return query<any[]>("SELECT id,module,to_email,to_name,subject,status,attempts,created_at,accepted_at,delivered_at,opened_at,open_count,click_count,last_error FROM tenant_email_messages WHERE tenant_id=? ORDER BY id DESC LIMIT ?", [tenantId, Math.min(Math.max(limit, 1), 200)])
}

export async function configureTenantEmailSender(input: { tenantId: number; module: EmailModule; fromName?: string | null; fromAddress?: string | null; replyTo?: string | null; transportDepartment: Sender["transport_department"]; actorId?: number | null }) {
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0 || !["sales","hr","finance","operations","recruit"].includes(input.transportDepartment)) throw new Error("Invalid sender configuration")
  await ensureEmailEngineSchema()
  await query(`INSERT INTO tenant_email_senders (tenant_id,module,from_name,from_address,reply_to,transport_department,created_by) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE from_name=VALUES(from_name),from_address=VALUES(from_address),reply_to=VALUES(reply_to),transport_department=VALUES(transport_department),enabled=1`, [input.tenantId,input.module,input.fromName ?? null,input.fromAddress ?? null,input.replyTo ?? null,input.transportDepartment,input.actorId ?? null])
}
