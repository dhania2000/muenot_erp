import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { query, withTransaction } from "@/lib/db"
import { ensureWorkflowSchema } from "./schema"
import { analyzeWorkflow, approvalAllowed, assertPublishable, matches, simulateWorkflow, validateWorkflow, type PublishContext, type Workflow } from "./model"
import { publishedDefinition } from "./published"
import { deliverWebhook } from "./webhook"
import { enforceFeature } from "@/lib/platform/feature-guard"
import { recordAuditLog } from "@/lib/audit-log-store"
import { fingerprint } from "@/lib/job-idempotency"
import { enqueueNotification } from "@/lib/notification-engine/service"
import { sendEmail } from "@/lib/email"
import { getWhatsAppIntegrationForTenant, sendWhatsAppText } from "@/lib/whatsapp"
import { meterUsage } from "@/lib/billing/usage-guard"
import { ensureEventSchema } from "@/lib/events/schema"

// Carries an HTTP status so the route can distinguish entitlement/permission
// failures from ordinary validation errors without leaking internals.
export class WorkflowError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
// Failures that cannot succeed on retry (the engine fails the run immediately).
class PermanentFailure extends Error {}
const MAX_ATTEMPTS = 3

const parse = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v
const utcSql = (v: Date) => v.toISOString().slice(0,19).replace("T"," ")
const table = (w: Workflow) => w.module === "sales_leads" ? "sales_leads" : "erp_workflow_tasks"
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string,string>)[c])
async function rows(c: PoolConnection, sql: string, values: unknown[] = []): Promise<any[]> { const [r] = await c.query(sql, values); return r as any[] }
async function member(c: PoolConnection, tenant: number, id: number, admin = false) {
  const r = await rows(c, `SELECT id FROM users WHERE tenant_id=? AND id=? AND status='active' ${admin ? "AND tenant_role IN ('tenant_admin','tenant_owner')" : ""}`, [tenant,id])
  if (!r.length) throw new PermanentFailure("Recipient must be an active member of this tenant; approvers must be tenant admins")
}
async function event(c: PoolConnection, run: any, kind: string, actor: number | null = null) {
  await c.query("INSERT INTO erp_workflow_events (tenant_id,run_id,step,event_type,actor_id) VALUES (?,?,?,?,?)", [run.tenant_id,run.id,run.cursor,kind,actor])
}
async function notice(c: PoolConnection, tenant: number, runId: number, user: number, message: string, approval = false, step = 0) {
  await c.query("INSERT INTO erp_workflow_notices (tenant_id,run_id,user_id,message) VALUES (?,?,?,?)",[tenant,runId,user,message])
  await enqueueNotification(c,{tenantId:tenant,userId:user,channel:"in_app",key:`workflow:${runId}:${step}:${user}`,title:approval?"Workflow approval requested":"Workflow notification",body:message,link:approval?"/admin/workflows":"/dashboard",priority:approval?10:5,context:{moduleKey:"workflows",action:"create",entityTable:"erp_workflow_runs",entityId:String(runId)}})
}
export function webhookTargets(tenant: number): string[] {
  try {
    const config = JSON.parse(process.env.WORKFLOW_WEBHOOK_TARGETS || "{}")
    const own = config?.[String(tenant)]
    return own && typeof own === "object" ? Object.keys(own).filter(k => typeof own[k] === "string") : []
  } catch { return [] }
}
const emailConfigured = () => Boolean(process.env.SMTP_HOST || process.env.SALES_SMTP_HOST || process.env.GMAIL_CLIENT_ID || process.env.RESEND_API_KEY)
async function publishContext(c: PoolConnection, tenant: number, actor: number, w: Workflow): Promise<PublishContext> {
  const ids = [...new Set([...w.actions, ...w.elseActions].flatMap(a => "userId" in a ? [a.userId] : []))]
  const users = ids.length ? await rows(c,`SELECT id,tenant_role FROM users WHERE tenant_id=? AND status='active' AND id IN (${ids.map(() => "?").join(",")})`,[tenant,...ids]) : []
  const needsWhatsApp = [...w.actions, ...w.elseActions].some(a => a.type === "whatsapp")
  return {
    actorId: actor,
    webhookTargets: webhookTargets(tenant),
    emailConfigured: emailConfigured(),
    whatsappConfigured: needsWhatsApp ? Boolean(await getWhatsAppIntegrationForTenant(tenant).catch(() => null)) : true,
    activeMembers: users.map(u => Number(u.id)),
    adminMembers: users.filter(u => ["tenant_admin","tenant_owner"].includes(u.tenant_role)).map(u => Number(u.id)),
  }
}
async function requireAdmin(tenant: number, actor: number) {
  const admin = await query<any[]>("SELECT id FROM users WHERE tenant_id=? AND id=? AND status='active' AND tenant_role IN ('tenant_admin','tenant_owner')",[tenant,actor])
  if (!admin.length) throw new WorkflowError("Tenant administrator access is required", 403)
}
async function entitled(tenant: number, usage = 0) {
  const gate = await enforceFeature(tenant, "automation.workflows", { usage })
  if (!gate.ok) throw new WorkflowError(gate.reason || "Automation workflows are not available on your plan", 402)
}
const audit = (tenant: number, actor: number, action: string, id: number, label: string | null, metadata: Record<string, unknown>) =>
  recordAuditLog({ action, entityType: action.startsWith("workflow.run") ? "erp_workflow_runs" : "erp_workflows", entityId: id, entityLabel: label, metadata, context: { tenantId: tenant, actorUserId: actor } })

// Save always writes a new immutable version. If the workflow is published, the
// live version keeps running; the edit becomes a pending draft until re-published.
export async function saveWorkflow(tenant: number, actor: number, input: unknown, id?: number, expectedVersion?: number) {
  const w = validateWorkflow(input)
  await ensureWorkflowSchema()
  const saved = await withTransaction(async c => {
    await member(c,tenant,actor,true)
    for (const a of [...w.actions, ...w.elseActions]) if ("userId" in a) await member(c,tenant,a.userId,a.type === "approval")
    if (id) {
      const [existing] = await rows(c,"SELECT id,version FROM erp_workflows WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
      if (!existing) throw new WorkflowError("Workflow not found", 404)
      if (expectedVersion != null && Number(existing.version || 1) !== expectedVersion) throw new WorkflowError("This workflow changed since you opened it; reload before saving", 409)
      const nextVersion = Number(existing.version || 1) + 1
      await c.query("UPDATE erp_workflows SET name=?,description=?,definition=?,version=? WHERE tenant_id=? AND id=?",[w.name,w.description,JSON.stringify(w),nextVersion,tenant,id])
      await c.query("INSERT INTO erp_workflow_versions (tenant_id,workflow_id,version,name,description,definition,changed_by) VALUES (?,?,?,?,?,?,?)",[tenant,id,nextVersion,w.name,w.description,JSON.stringify(w),actor])
      return { id: Number(id), version: nextVersion }
    }
    const [r] = await c.query<any>("INSERT INTO erp_workflows (tenant_id,name,description,definition,created_by,status) VALUES (?,?,?,?,?,'draft')", [tenant,w.name,w.description,JSON.stringify(w),actor])
    const newId = Number(r.insertId)
    await c.query("INSERT INTO erp_workflow_versions (tenant_id,workflow_id,version,name,description,definition,changed_by) VALUES (?,?,1,?,?,?,?)",[tenant,newId,w.name,w.description,JSON.stringify(w),actor])
    return { id: newId, version: 1 }
  })
  await audit(tenant, actor, id ? "workflow.update" : "workflow.create", saved.id, w.name, { module: w.module, trigger: w.trigger, version: saved.version })
  return saved.id
}
export async function setWorkflowEnabled(tenant: number, actor: number, id: number, enabled: boolean) {
  await ensureWorkflowSchema()
  await withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [existing] = await rows(c,"SELECT id FROM erp_workflows WHERE tenant_id=? AND id=?",[tenant,id])
    if (!existing) throw new WorkflowError("Workflow not found", 404)
    await c.query("UPDATE erp_workflows SET enabled=? WHERE tenant_id=? AND id=?",[enabled ? 1 : 0,tenant,id])
  })
  await audit(tenant, actor, enabled ? "workflow.enable" : "workflow.disable", id, null, {})
}
// Keeps the event bus subscription for an event-triggered workflow in step with
// its published definition. Reuses erp_event_subscriptions rather than a parallel router.
async function syncEventSubscription(c: PoolConnection, tenant: number, actor: number, id: number, w: Workflow) {
  const [existing] = await rows(c,"SELECT id FROM erp_event_subscriptions WHERE tenant_id=? AND JSON_UNQUOTE(JSON_EXTRACT(config,'$.handler'))='workflow' AND JSON_EXTRACT(config,'$.workflowId')=? AND JSON_EXTRACT(config,'$.managedBy')='builder' ORDER BY id LIMIT 1 FOR UPDATE",[tenant,id])
  if (w.trigger !== "event") {
    if (existing) await c.query("UPDATE erp_event_subscriptions SET enabled=0 WHERE tenant_id=? AND id=?",[tenant,existing.id])
    return
  }
  const config = JSON.stringify({ name: w.name, eventType: w.eventType, handler: "workflow", workflowId: id, managedBy: "builder", definition: w })
  if (existing) await c.query("UPDATE erp_event_subscriptions SET name=?,event_type=?,config=?,created_by=?,enabled=1 WHERE tenant_id=? AND id=?",[w.name.slice(0,120),w.eventType,config,actor,tenant,existing.id])
  else await c.query("INSERT INTO erp_event_subscriptions (tenant_id,name,event_type,config,created_by) VALUES (?,?,?,?,?)",[tenant,w.name.slice(0,120),w.eventType,config,actor])
}
// Publish: re-validates the current version against the safety analyzer using the
// tenant's live environment, checks the entitlement, then makes it the live version.
// Idempotent: publishing an already-live version is a no-op.
export async function publishWorkflow(tenant: number, actor: number, id: number, expectedVersion?: number) {
  await ensureWorkflowSchema()
  await ensureEventSchema()
  const result = await withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [d] = await rows(c,"SELECT * FROM erp_workflows WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!d) throw new WorkflowError("Workflow not found", 404)
    const version = Number(d.version || 1)
    if (expectedVersion != null && expectedVersion !== version) throw new WorkflowError("This workflow changed since you reviewed it; reload before publishing", 409)
    const w = validateWorkflow(parse(d.definition))
    if (d.status === "published" && Number(d.published_version) === version && Number(d.enabled) === 1) return { id, version, name: w.name, unchanged: true }
    assertPublishable(w, await publishContext(c,tenant,actor,w))
    const [count] = await rows(c,"SELECT COUNT(*) AS n FROM erp_workflows WHERE tenant_id=? AND status='published' AND enabled=1 AND id<>?",[tenant,id])
    await entitled(tenant, Number(count?.n || 0))
    await c.query("UPDATE erp_workflows SET status='published',enabled=1,published_version=version,published_at=UTC_TIMESTAMP() WHERE tenant_id=? AND id=?",[tenant,id])
    await syncEventSubscription(c,tenant,actor,id,w)
    return { id, version, name: w.name, unchanged: false }
  })
  if (!result.unchanged) await audit(tenant, actor, "workflow.publish", id, result.name, { version: result.version })
  return result
}
// Rollback copies a prior version into a new version (history is append-only).
// With publish=true it goes live immediately, subject to the same publish gate.
export async function rollbackWorkflow(tenant: number, actor: number, id: number, toVersion: number, publish = false) {
  if (!Number.isSafeInteger(toVersion) || toVersion <= 0) throw new WorkflowError("A valid target version is required")
  await ensureWorkflowSchema()
  const result = await withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [d] = await rows(c,"SELECT id,version FROM erp_workflows WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!d) throw new WorkflowError("Workflow not found", 404)
    const [ver] = await rows(c,"SELECT definition FROM erp_workflow_versions WHERE tenant_id=? AND workflow_id=? AND version=?",[tenant,id,toVersion])
    if (!ver) throw new WorkflowError("Version not found", 404)
    const w = validateWorkflow(parse(ver.definition))
    const nextVersion = Number(d.version || 1) + 1
    await c.query("UPDATE erp_workflows SET name=?,description=?,definition=?,version=? WHERE tenant_id=? AND id=?",[w.name,w.description,JSON.stringify(w),nextVersion,tenant,id])
    await c.query("INSERT INTO erp_workflow_versions (tenant_id,workflow_id,version,name,description,definition,changed_by) VALUES (?,?,?,?,?,?,?)",[tenant,id,nextVersion,w.name,w.description,JSON.stringify(w),actor])
    return { id, version: nextVersion, from: toVersion, name: w.name }
  })
  await audit(tenant, actor, "workflow.rollback", id, result.name, { from: result.from, version: result.version })
  const published = publish ? await publishWorkflow(tenant, actor, id, result.version) : null
  return { ...result, published: Boolean(published) }
}
// Validation + dry run. Reports static issues against the tenant's live
// environment and, when a record is given, the exact path the engine would take.
// Reads only; never writes, dispatches or meters.
export async function simulateWorkflowRun(tenant: number, actor: number, input: unknown, recordId?: number) {
  const w = validateWorkflow(input)
  await ensureWorkflowSchema()
  await requireAdmin(tenant, actor)
  return withTransaction(async c => {
    const ctx = await publishContext(c,tenant,actor,w)
    if (!recordId) return { issues: analyzeWorkflow(w, ctx), simulation: null }
    const [record] = await rows(c,`SELECT * FROM ${table(w)} WHERE tenant_id=? AND id=?`,[tenant,recordId])
    if (!record) throw new WorkflowError("Record not found in this tenant", 404)
    const simulation = simulateWorkflow(w, record, ctx)
    return { issues: simulation.issues, simulation }
  })
}
export async function previewWorkflow(tenant: number, actor: number, input: unknown, recordId: number) {
  const w = validateWorkflow(input)
  await ensureWorkflowSchema()
  await requireAdmin(tenant, actor)
  const record = (await query<any[]>(`SELECT * FROM ${table(w)} WHERE tenant_id=? AND id=?`,[tenant,recordId]))[0]
  if (!record) throw new WorkflowError("Record not found in this tenant", 404)
  const matched = matches(w, record)
  return { matched, branch: matched ? "then" : "else", actions: matched ? w.actions : w.elseActions }
}
export async function startWorkflow(tenant: number, actor: number, workflowId: number, recordId: number, key: string, at?: string) {
  if (![tenant,actor,workflowId,recordId].every(n => Number.isSafeInteger(n) && n > 0) || typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(key)) throw new WorkflowError("Valid workflow, record and request key required")
  await ensureWorkflowSchema()
  const runId = await withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [d] = await rows(c,"SELECT * FROM erp_workflows WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,workflowId])
    if (!d || !Number(d.enabled)) throw new WorkflowError("Workflow unavailable", 404)
    if (d.status !== "published") throw new WorkflowError("Workflow is not published; publish it before running", 409)
    const hash = fingerprint({recordId,actor,at:at ?? null})
    const [existing] = await rows(c,"SELECT id,request_hash FROM erp_workflow_runs WHERE tenant_id=? AND workflow_id=? AND request_key=?",[tenant,workflowId,key])
    if (existing) { if (existing.request_hash !== hash) throw new WorkflowError("Request key already used for different input", 409); return { id: Number(existing.id), replay: true } }
    const w = await publishedDefinition(c, tenant, d)
    if (w.trigger === "event") throw new WorkflowError("Event-triggered workflows start from their business event, not manually", 409)
    await entitled(tenant)
    const date = at ? new Date(at) : new Date()
    if (!Number.isFinite(date.getTime()) || (at != null && (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(at))) || (w.trigger === "scheduled" && (!at || date.getTime() <= Date.now())) || (w.trigger === "manual" && at)) throw new WorkflowError("Scheduled workflows require a future UTC date; manual workflows run now")
    const [record] = await rows(c,`SELECT id FROM ${table(w)} WHERE tenant_id=? AND id=?`,[tenant,recordId])
    if (!record) throw new WorkflowError("Record not found in this tenant", 404)
    const [r] = await c.query<any>("INSERT INTO erp_workflow_runs (tenant_id,workflow_id,snapshot,record_id,request_key,request_hash,requested_by,available_at) VALUES (?,?,?,?,?,?,?,?)",[tenant,workflowId,JSON.stringify(w),recordId,key,hash,actor,utcSql(date)])
    await event(c,{tenant_id:tenant,id:r.insertId,cursor:0},"requested",actor)
    // Idempotent on the run id; recorded under the explicit tenant since the worker has no session scope.
    meterUsage({ meterKey: "automation_runs", quantity: 1, source: "workflow", refId: String(r.insertId), idempotencyKey: `wf:${r.insertId}`, tenantId: tenant })
    return { id: Number(r.insertId), replay: false }
  })
  if (!runId.replay) await audit(tenant, actor, "workflow.run.start", runId.id, null, { workflowId, recordId })
  return runId.id
}
export async function decideWorkflow(tenant: number, actor: number, id: number, approve: boolean) {
  await ensureWorkflowSchema()
  await withTransaction(async c => {
    const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!run || run.status !== "approval") throw new WorkflowError("No pending approval", 409)
    const w = validateWorkflow(parse(run.snapshot)), actions = run.branch === "else" ? w.elseActions : w.actions, a = actions[run.cursor]
    if (a?.type !== "approval" || !approvalAllowed(Number(run.requested_by),actor,a.userId)) throw new WorkflowError("Only the designated approver can decide; self-approval is forbidden", 403)
    await member(c,tenant,actor,true)
    await c.query("UPDATE erp_workflow_runs SET status=?,cursor=cursor+1,available_at=UTC_TIMESTAMP() WHERE tenant_id=? AND id=?",[approve ? "queued" : "rejected",tenant,id])
    await event(c,run,approve ? "approved" : "rejected",actor)
  })
  await audit(tenant, actor, approve ? "workflow.run.approve" : "workflow.run.reject", id, null, {})
}
export async function cancelWorkflow(tenant: number, actor: number, id: number) {
  await ensureWorkflowSchema()
  await withTransaction(async c => {
    const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!run || !["queued","waiting","approval"].includes(run.status)) throw new WorkflowError("Only a pending run can be cancelled; dispatched webhooks cannot be undone", 409)
    await c.query("UPDATE erp_workflow_runs SET status='cancelled' WHERE tenant_id=? AND id=?",[tenant,id])
    await event(c,run,"cancelled",actor)
  })
  await audit(tenant, actor, "workflow.run.cancel", id, null, {})
}
// Manual retry is only allowed where the failed step provably had no effect:
// local actions roll back to a savepoint. External deliveries (webhook/email/
// WhatsApp) may already have happened, so retrying them is blocked as unsafe.
const RETRYABLE_ERRORS = ["action_failed", "action_unavailable"]
export async function retryWorkflowRun(tenant: number, actor: number, id: number) {
  await ensureWorkflowSchema()
  await withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!run) throw new WorkflowError("Run not found", 404)
    if (run.status !== "failed") throw new WorkflowError("Only failed runs can be retried", 409)
    if (!RETRYABLE_ERRORS.includes(run.error_code)) throw new WorkflowError("Blocked: the failed step may already have been delivered externally, so it cannot be retried safely", 409)
    await c.query("UPDATE erp_workflow_runs SET status='queued',attempts=0,error_code=NULL,available_at=UTC_TIMESTAMP() WHERE tenant_id=? AND id=?",[tenant,id])
    await event(c,run,"manual_retry",actor)
  })
  await audit(tenant, actor, "workflow.run.retry", id, null, {})
}
export async function workflowOverview(tenant: number, actor: number) {
  await ensureWorkflowSchema()
  const [definitions,runs,notices,tasks,events,versions,assets] = await Promise.all([
    query("SELECT id,name,description,definition,enabled,version,status,published_version,published_at FROM erp_workflows WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT id,workflow_id,record_id,snapshot,status,cursor,branch,attempts,error_code,available_at,created_at FROM erp_workflow_runs WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT id,run_id,message,created_at FROM erp_workflow_notices WHERE tenant_id=? AND user_id=? ORDER BY id DESC LIMIT 50",[tenant,actor]),
    query("SELECT id,title,priority,status,assigned_to,source_run_id FROM erp_workflow_tasks WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT run_id,step,event_type,actor_id,created_at FROM erp_workflow_events WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT workflow_id,version,name,definition,changed_by,created_at FROM erp_workflow_versions WHERE tenant_id=? ORDER BY id DESC LIMIT 200",[tenant]),
    query("SELECT id,run_id,asset_tag,assigned_to,created_at FROM erp_workflow_asset_actions WHERE tenant_id=? ORDER BY id DESC LIMIT 50",[tenant]),
  ])
  return { definitions,runs,notices,tasks,events,versions,assets,webhookTargets:webhookTargets(tenant) }
}

type ExternalDispatch =
  | { kind: "webhook"; tenant: number; id: number; step: number; target: string; recordId: number }
  | { kind: "email"; tenant: number; id: number; step: number; userId: number; subject: string; message: string }
  | { kind: "whatsapp"; tenant: number; id: number; step: number; phone: string; message: string }

// One short transaction per action. Concurrent dispatchers serialize on the run;
// business writes and cursor advancement commit together. External I/O is outside it.
export async function advanceWorkflow(id: number) {
  const external = await withTransaction<ExternalDispatch | null>(async c => {
    const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE id=? FOR UPDATE",[id])
    if (!run || !["queued","waiting"].includes(run.status)) return null
    const [due] = await rows(c,"SELECT id FROM erp_workflow_runs WHERE id=? AND available_at<=UTC_TIMESTAMP()",[id])
    if (!due) return null
    const w = validateWorkflow(parse(run.snapshot)), tenant = Number(run.tenant_id)
    await c.query("SAVEPOINT workflow_action")
    try {
      await member(c,tenant,Number(run.requested_by),true)
      const [record] = await rows(c,`SELECT * FROM ${table(w)} WHERE tenant_id=? AND id=? FOR UPDATE`,[tenant,run.record_id])
      if (!record) throw new PermanentFailure("missing_record")
      if (run.cursor === 0 && run.branch !== "else" && !matches(w,record)) {
        if (w.elseActions.length) {
          await c.query("UPDATE erp_workflow_runs SET branch='else' WHERE id=?",[id]); await event(c,run,"else_branch"); return null
        }
        await c.query("UPDATE erp_workflow_runs SET status='skipped' WHERE id=?",[id]); await event(c,run,"conditions_not_met"); return null
      }
      const actions = run.branch === "else" ? w.elseActions : w.actions
      const a = actions[run.cursor]
      if (!a) { await c.query("UPDATE erp_workflow_runs SET status='completed' WHERE id=?",[id]); await event(c,run,"completed"); return null }
      if ("userId" in a) await member(c,tenant,a.userId,a.type === "approval")
      if (a.type === "approval") {
        if (!approvalAllowed(Number(run.requested_by),a.userId,a.userId)) throw new PermanentFailure("self_approval")
        await c.query("UPDATE erp_workflow_runs SET status='approval' WHERE id=?",[id])
        await notice(c,tenant,id,a.userId,a.message,true,Number(run.cursor))
        await event(c,run,"approval_requested"); return null
      }
      // Unavailable destinations are blocked before dispatch so the run fails
      // cleanly (retryable) instead of being marked as an uncertain delivery.
      if (a.type === "webhook") {
        if (!webhookTargets(tenant).includes(a.target)) throw new PermanentFailure("action_unavailable")
        await c.query("UPDATE erp_workflow_runs SET status='external' WHERE id=?",[id]); await event(c,run,"webhook_dispatching")
        return { kind:"webhook", tenant, id, step:Number(run.cursor), target:a.target, recordId:Number(run.record_id) }
      }
      if (a.type === "email") {
        await c.query("UPDATE erp_workflow_runs SET status='external' WHERE id=?",[id]); await event(c,run,"email_dispatching")
        return { kind:"email", tenant, id, step:Number(run.cursor), userId:a.userId, subject:a.subject, message:a.message }
      }
      if (a.type === "whatsapp") {
        await c.query("UPDATE erp_workflow_runs SET status='external' WHERE id=?",[id]); await event(c,run,"whatsapp_dispatching")
        return { kind:"whatsapp", tenant, id, step:Number(run.cursor), phone:a.phone, message:a.message }
      }
      let available: Date | null = null
      if (a.type === "delay") available = new Date(Date.now()+a.seconds*1000)
      if (a.type === "schedule") available = new Date(a.at)
      if (a.type === "notify") await notice(c,tenant,id,a.userId,a.message,false,Number(run.cursor))
      if (a.type === "create") await c.query("INSERT INTO erp_workflow_tasks (tenant_id,title,description,assigned_to,source_run_id) VALUES (?,?,?,?,?)",[tenant,a.title,a.description,a.userId,id])
      if (a.type === "asset") {
        await c.query("INSERT INTO erp_workflow_asset_actions (tenant_id,run_id,asset_tag,assigned_to) VALUES (?,?,?,?)",[tenant,id,a.assetTag,a.userId])
        await notice(c,tenant,id,a.userId,`Asset ${a.assetTag} has been assigned to you`,false,Number(run.cursor))
      }
      if (a.type === "update") await c.query(`UPDATE ${table(w)} SET ${a.field}=? ${w.module === "sales_leads" ? ",row_version=row_version+1" : ""} WHERE tenant_id=? AND id=?`,[a.value,tenant,run.record_id])
      if (a.type === "assign") {
        await c.query(`UPDATE ${table(w)} SET assigned_to=? ${w.module === "sales_leads" ? ",row_version=row_version+1" : ""} WHERE tenant_id=? AND id=?`,[a.userId,tenant,run.record_id])
        if (w.module === "sales_leads") await c.query("INSERT INTO sales_lead_owner_history (lead_id,from_owner,to_owner,note,changed_by) VALUES (?,?,?,'Workflow assignment',?)",[run.record_id,record.assigned_to,a.userId,run.requested_by])
      }
      await event(c,run,a.type)
      await c.query("UPDATE erp_workflow_runs SET cursor=cursor+1,attempts=0,status=?,available_at=COALESCE(?,UTC_TIMESTAMP()) WHERE id=?",[available ? "waiting" : "queued",available ? utcSql(available) : null,id])
      return null
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT workflow_action")
      const attempts = Number(run.attempts || 0) + 1
      if (!(error instanceof PermanentFailure) && attempts < MAX_ATTEMPTS) {
        // Transient local failure (lock timeout, deadlock): effects were rolled back, so retrying is safe.
        await c.query("UPDATE erp_workflow_runs SET status='queued',attempts=?,error_code='action_retrying',available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND) WHERE id=?",[attempts,30 * 2 ** (attempts - 1),id])
        await event(c,run,"action_retry_scheduled")
        return null
      }
      const code = error instanceof PermanentFailure && error.message === "action_unavailable" ? "action_unavailable" : "action_failed"
      await c.query(`UPDATE erp_workflow_runs SET status='failed',attempts=?,error_code='${code}' WHERE id=?`,[attempts,id]); await event(c,run,"action_failed")
      return null
    }
  })
  if (external) {
    let success = false, errorCode = "action_failed"
    try {
      if (external.kind === "webhook") {
        await deliverWebhook(external.tenant,external.target,id,external.step,external.recordId)
      } else if (external.kind === "email") {
        const [user] = await query<any[]>("SELECT email, first_name, last_name FROM users WHERE id=? AND tenant_id=?",[external.userId,external.tenant])
        if (!user?.email) throw new Error("recipient_missing_email")
        await sendEmail({ to:user.email, subject:external.subject, html:`<p>${escapeHtml(external.message)}</p>` })
      } else {
        const integration = await getWhatsAppIntegrationForTenant(external.tenant)
        if (!integration) throw new Error("whatsapp_not_configured")
        const result = await sendWhatsAppText({ integration, to:external.phone, body:external.message })
        if (!result.ok) throw new Error(result.error || "whatsapp_send_failed")
      }
      success = true
    } catch {
      // Do not retry ambiguous delivery (webhook/email/WhatsApp may or may not have gone out).
      errorCode = external.kind === "email" ? "email_delivery_failed" : external.kind === "whatsapp" ? "whatsapp_delivery_failed" : "webhook_delivery_uncertain"
    }
    await withTransaction(async c => {
      const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE id=? FOR UPDATE",[id])
      if (run?.status !== "external" || Number(run.cursor) !== external.step) return
      await c.query("UPDATE erp_workflow_runs SET status=?,cursor=cursor+?,error_code=?,available_at=UTC_TIMESTAMP() WHERE id=?",[success ? "queued" : "failed",success ? 1 : 0,success ? null : errorCode,id])
      await event(c,run,success ? `${external.kind}_delivered` : `${external.kind}_delivery_failed`)
    })
  }
}
export async function runWorkflowWorker() {
  await ensureWorkflowSchema()
  // A crashed process may have delivered a webhook/email/WhatsApp message. Never automatically resend it.
  await query("UPDATE erp_workflow_runs SET status='failed',error_code='webhook_delivery_uncertain' WHERE status='external' AND updated_at < CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE")
  const due = await query<{id:number}[]>("SELECT id FROM erp_workflow_runs WHERE status IN ('queued','waiting') AND available_at<=UTC_TIMESTAMP() ORDER BY available_at,id LIMIT 20")
  for (const run of due) await advanceWorkflow(Number(run.id))
  return { processed:due.length }
}
