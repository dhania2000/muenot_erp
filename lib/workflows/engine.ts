import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { query, withTransaction } from "@/lib/db"
import { ensureWorkflowSchema } from "./schema"
import { approvalAllowed, matches, validateWorkflow, type Workflow } from "./model"
import { deliverWebhook } from "./webhook"
import { fingerprint } from "@/lib/job-idempotency"
import { sendEmail } from "@/lib/email"
import { getWhatsAppIntegrationForTenant, sendWhatsAppText } from "@/lib/whatsapp"

const parse = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v
const utcSql = (v: Date) => v.toISOString().slice(0,19).replace("T"," ")
const table = (w: Workflow) => w.module === "sales_leads" ? "sales_leads" : "erp_workflow_tasks"
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string,string>)[c])
async function rows(c: PoolConnection, sql: string, values: unknown[] = []): Promise<any[]> { const [r] = await c.query(sql, values); return r as any[] }
async function member(c: PoolConnection, tenant: number, id: number, admin = false) {
  const r = await rows(c, `SELECT id FROM users WHERE tenant_id=? AND id=? AND status='active' ${admin ? "AND tenant_role IN ('tenant_admin','tenant_owner')" : ""}`, [tenant,id])
  if (!r.length) throw new Error("Recipient must be an active member of this tenant; approvers must be tenant admins")
}
async function event(c: PoolConnection, run: any, kind: string, actor: number | null = null) {
  await c.query("INSERT INTO erp_workflow_events (tenant_id,run_id,step,event_type,actor_id) VALUES (?,?,?,?,?)", [run.tenant_id,run.id,run.cursor,kind,actor])
}
async function notice(c: PoolConnection, tenant: number, runId: number, user: number, message: string, approval = false) {
  await c.query("INSERT INTO erp_workflow_notices (tenant_id,run_id,user_id,message) VALUES (?,?,?,?)",[tenant,runId,user,message])
  await c.query("INSERT INTO notifications (user_id,module_key,action,title,body,link,entity_table,entity_id) VALUES (?,'workflows','create',?,?,?,'erp_workflow_runs',?)",[user,approval ? "Workflow approval requested" : "Workflow notification",message.slice(0,500),approval ? "/admin/workflows" : "/dashboard",String(runId)])
}
export async function saveWorkflow(tenant: number, actor: number, input: unknown, id?: number) {
  const w = validateWorkflow(input)
  await ensureWorkflowSchema()
  return withTransaction(async c => {
    await member(c,tenant,actor,true)
    for (const a of [...w.actions, ...w.elseActions]) if ("userId" in a) await member(c,tenant,a.userId,a.type === "approval")
    if (id) {
      const [existing] = await rows(c,"SELECT id,version FROM erp_workflows WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
      if (!existing) throw new Error("Workflow not found")
      const nextVersion = Number(existing.version || 1) + 1
      await c.query("UPDATE erp_workflows SET name=?,description=?,definition=?,version=? WHERE tenant_id=? AND id=?",[w.name,w.description,JSON.stringify(w),nextVersion,tenant,id])
      await c.query("INSERT INTO erp_workflow_versions (tenant_id,workflow_id,version,name,description,definition,changed_by) VALUES (?,?,?,?,?,?,?)",[tenant,id,nextVersion,w.name,w.description,JSON.stringify(w),actor])
      return Number(id)
    }
    const [r] = await c.query<any>("INSERT INTO erp_workflows (tenant_id,name,description,definition,created_by) VALUES (?,?,?,?,?)", [tenant,w.name,w.description,JSON.stringify(w),actor])
    const newId = Number(r.insertId)
    await c.query("INSERT INTO erp_workflow_versions (tenant_id,workflow_id,version,name,description,definition,changed_by) VALUES (?,?,1,?,?,?,?)",[tenant,newId,w.name,w.description,JSON.stringify(w),actor])
    return newId
  })
}
export async function setWorkflowEnabled(tenant: number, actor: number, id: number, enabled: boolean) {
  await ensureWorkflowSchema()
  return withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [existing] = await rows(c,"SELECT id FROM erp_workflows WHERE tenant_id=? AND id=?",[tenant,id])
    if (!existing) throw new Error("Workflow not found")
    await c.query("UPDATE erp_workflows SET enabled=? WHERE tenant_id=? AND id=?",[enabled ? 1 : 0,tenant,id])
  })
}
// Dry run: validates the draft definition and reports which branch (THEN/ELSE) would
// fire against a real record and which actions would run. Never writes anything.
export async function previewWorkflow(tenant: number, actor: number, input: unknown, recordId: number) {
  const w = validateWorkflow(input)
  await ensureWorkflowSchema()
  const admin = await query<any[]>("SELECT id FROM users WHERE tenant_id=? AND id=? AND status='active' AND tenant_role IN ('tenant_admin','tenant_owner')",[tenant,actor])
  if (!admin.length) throw new Error("Tenant administrator access is required")
  const record = (await query<any[]>(`SELECT * FROM ${table(w)} WHERE tenant_id=? AND id=?`,[tenant,recordId]))[0]
  if (!record) throw new Error("Record not found in this tenant")
  const matched = matches(w, record)
  return { matched, branch: matched ? "then" : "else", actions: matched ? w.actions : w.elseActions }
}
export async function startWorkflow(tenant: number, actor: number, workflowId: number, recordId: number, key: string, at?: string) {
  if (![tenant,actor,workflowId,recordId].every(n => Number.isSafeInteger(n) && n > 0) || typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(key)) throw new Error("Valid workflow, record and request key required")
  await ensureWorkflowSchema()
  return withTransaction(async c => {
    await member(c,tenant,actor,true)
    const [d] = await rows(c,"SELECT * FROM erp_workflows WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,workflowId])
    if (!d || !d.enabled) throw new Error("Workflow unavailable")
    const w = validateWorkflow(parse(d.definition))
    const hash = fingerprint({recordId,actor,at:at ?? null})
    const [existing] = await rows(c,"SELECT id,request_hash FROM erp_workflow_runs WHERE tenant_id=? AND workflow_id=? AND request_key=?",[tenant,workflowId,key])
    if (existing) { if (existing.request_hash !== hash) throw new Error("Request key already used for different input"); return Number(existing.id) }
    const date = at ? new Date(at) : new Date()
    if (!Number.isFinite(date.getTime()) || (at != null && (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(at))) || (w.trigger === "scheduled" && (!at || date.getTime() <= Date.now())) || (w.trigger === "manual" && at)) throw new Error("Scheduled workflows require a future UTC date; manual workflows run now")
    const [record] = await rows(c,`SELECT id FROM ${table(w)} WHERE tenant_id=? AND id=?`,[tenant,recordId])
    if (!record) throw new Error("Record not found in this tenant")
    const [r] = await c.query<any>("INSERT INTO erp_workflow_runs (tenant_id,workflow_id,snapshot,record_id,request_key,request_hash,requested_by,available_at) VALUES (?,?,?,?,?,?,?,?)",[tenant,workflowId,JSON.stringify(w),recordId,key,hash,actor,utcSql(date)])
    await event(c,{tenant_id:tenant,id:r.insertId,cursor:0},"requested",actor)
    return Number(r.insertId)
  })
}
export async function decideWorkflow(tenant: number, actor: number, id: number, approve: boolean) {
  await ensureWorkflowSchema()
  return withTransaction(async c => {
    const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!run || run.status !== "approval") throw new Error("No pending approval")
    const w = validateWorkflow(parse(run.snapshot)), actions = run.branch === "else" ? w.elseActions : w.actions, a = actions[run.cursor]
    if (a?.type !== "approval" || !approvalAllowed(Number(run.requested_by),actor,a.userId)) throw new Error("Only the designated approver can decide; self-approval is forbidden")
    await member(c,tenant,actor,true)
    await c.query("UPDATE erp_workflow_runs SET status=?,cursor=cursor+1,available_at=UTC_TIMESTAMP() WHERE tenant_id=? AND id=?",[approve ? "queued" : "rejected",tenant,id])
    await event(c,run,approve ? "approved" : "rejected",actor)
  })
}
export async function cancelWorkflow(tenant: number, actor: number, id: number) {
  await ensureWorkflowSchema()
  return withTransaction(async c => {
    const [run] = await rows(c,"SELECT * FROM erp_workflow_runs WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if (!run || !["queued","waiting","approval"].includes(run.status)) throw new Error("Only a pending run can be cancelled; dispatched webhooks cannot be undone")
    await c.query("UPDATE erp_workflow_runs SET status='cancelled' WHERE tenant_id=? AND id=?",[tenant,id])
    await event(c,run,"cancelled",actor)
  })
}
export async function workflowOverview(tenant: number, actor: number) {
  await ensureWorkflowSchema()
  const [definitions,runs,notices,tasks,events,versions] = await Promise.all([
    query("SELECT id,name,description,definition,enabled,version FROM erp_workflows WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT id,workflow_id,record_id,snapshot,status,cursor,branch,error_code,available_at,created_at FROM erp_workflow_runs WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT id,run_id,message,created_at FROM erp_workflow_notices WHERE tenant_id=? AND user_id=? ORDER BY id DESC LIMIT 50",[tenant,actor]),
    query("SELECT id,title,priority,status,assigned_to,source_run_id FROM erp_workflow_tasks WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT run_id,step,event_type,actor_id,created_at FROM erp_workflow_events WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT workflow_id,version,changed_by,created_at FROM erp_workflow_versions WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
  ])
  return { definitions,runs,notices,tasks,events,versions }
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
      if (!record) throw new Error("missing_record")
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
        if (!approvalAllowed(Number(run.requested_by),a.userId,a.userId)) throw new Error("self_approval")
        await c.query("UPDATE erp_workflow_runs SET status='approval' WHERE id=?",[id])
        await notice(c,tenant,id,a.userId,a.message,true)
        await event(c,run,"approval_requested"); return null
      }
      if (a.type === "webhook") {
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
      if (a.type === "notify") await notice(c,tenant,id,a.userId,a.message)
      if (a.type === "create") await c.query("INSERT INTO erp_workflow_tasks (tenant_id,title,description,assigned_to,source_run_id) VALUES (?,?,?,?,?)",[tenant,a.title,a.description,a.userId,id])
      if (a.type === "update") await c.query(`UPDATE ${table(w)} SET ${a.field}=? ${w.module === "sales_leads" ? ",row_version=row_version+1" : ""} WHERE tenant_id=? AND id=?`,[a.value,tenant,run.record_id])
      if (a.type === "assign") {
        await c.query(`UPDATE ${table(w)} SET assigned_to=? ${w.module === "sales_leads" ? ",row_version=row_version+1" : ""} WHERE tenant_id=? AND id=?`,[a.userId,tenant,run.record_id])
        if (w.module === "sales_leads") await c.query("INSERT INTO sales_lead_owner_history (lead_id,from_owner,to_owner,note,changed_by) VALUES (?,?,?,'Workflow assignment',?)",[run.record_id,record.assigned_to,a.userId,run.requested_by])
      }
      await event(c,run,a.type)
      await c.query("UPDATE erp_workflow_runs SET cursor=cursor+1,status=?,available_at=COALESCE(?,UTC_TIMESTAMP()) WHERE id=?",[available ? "waiting" : "queued",available ? utcSql(available) : null,id])
      return null
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT workflow_action")
      await c.query("UPDATE erp_workflow_runs SET status='failed',error_code='action_failed' WHERE id=?",[id]); await event(c,run,"action_failed")
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
