"use client"
import { useEffect, useState } from "react"
import { FIELDS, OPERATORS, countRules, isRule, type Action, type Group, type Op, type Rule, type Workflow, type WorkflowModule } from "@/lib/workflows/model"

const initial: Workflow = { name: "", description: "", module: "sales_leads", trigger: "manual", conditions: { logic: "AND", children: [] }, actions: [], elseActions: [] }
const control = "rounded border bg-background px-3 py-2 w-full"

// SPECS 46–47 — Enterprise-friendly resource/trigger catalog for the "WHEN"
// section. Only "Leads" and "Tasks" (sales_leads / workflow_tasks) are wired
// to the execution engine (lib/workflows/model.ts) today; the remaining
// resources and triggers are shown so the full intended surface is
// discoverable, but they are visually flagged and cannot be saved until
// Codex wires the matching backend module.
const RESOURCE_CATALOG: { value: string; label: string; module?: WorkflowModule }[] = [
  { value: "sales_leads", label: "Leads", module: "sales_leads" },
  { value: "workflow_tasks", label: "Tasks", module: "workflow_tasks" },
  { value: "employees", label: "Employees" },
  { value: "vendors", label: "Vendors" },
  { value: "customers", label: "Customers" },
  { value: "deals", label: "Deals" },
  { value: "invoices", label: "Invoices" },
  { value: "payments", label: "Payments" },
  { value: "expenses", label: "Expenses" },
  { value: "leave_requests", label: "Leave Requests" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "files", label: "Files" },
  { value: "projects", label: "Projects" },
]
const RESOURCE_FIELDS: Record<string, string[]> = {
  employees: ["department", "designation", "employment_status"],
  vendors: ["status", "category", "risk_rating"],
  customers: ["status", "segment", "lifecycle_stage"],
  deals: ["stage", "value", "owner"],
  invoices: ["status", "amount", "due_date"],
  payments: ["status", "method", "amount"],
  expenses: ["status", "category", "amount"],
  leave_requests: ["status", "leave_type", "duration_days"],
  subscriptions: ["status", "plan", "renewal_date"],
  files: ["module", "classification", "scan_status"],
  projects: ["status", "priority", "owner"],
}
const TRIGGER_CATALOG: { value: string; label: string; trigger?: Workflow["trigger"] }[] = [
  { value: "manual", label: "Manual — run on request", trigger: "manual" },
  { value: "scheduled", label: "Scheduled — run at a set time", trigger: "scheduled" },
  { value: "record_created", label: "Record created" },
  { value: "record_updated", label: "Record updated" },
  { value: "field_changed", label: "Field changed" },
  { value: "status_changed", label: "Status changed" },
  { value: "employee_created", label: "Employee created" },
  { value: "vendor_created", label: "Vendor created" },
  { value: "invoice_created", label: "Invoice created" },
  { value: "payment_received", label: "Payment received" },
  { value: "leave_approved", label: "Leave approved" },
  { value: "deal_won", label: "Deal won" },
  { value: "subscription_renewed", label: "Subscription renewed" },
  { value: "file_uploaded", label: "File uploaded" },
]
const defaults: Record<Action["type"], Action> = {
  notify: { type: "notify", userId: 0, message: "" }, approval: { type: "approval", userId: 0, message: "" },
  delay: { type: "delay", seconds: 60 }, schedule: { type: "schedule", at: "" }, webhook: { type: "webhook", target: "" },
  update: { type: "update", field: "priority", value: "High" }, assign: { type: "assign", userId: 0 },
  create: { type: "create", title: "", description: "", userId: 0 },
  email: { type: "email", userId: 0, subject: "", message: "" }, whatsapp: { type: "whatsapp", phone: "", message: "" },
}

function RuleRow({ rule, fields, onChange, onRemove }: { rule: Rule; fields: string[]; onChange: (r: Rule) => void; onRemove: () => void }) {
  const op = OPERATORS.find((o) => o.value === rule.op)!
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Condition field" className={control} value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value })}>
        {fields.map((f) => <option key={f}>{f}</option>)}
      </select>
      <select aria-label="Comparison" className={control} value={rule.op} onChange={(e) => { const next = e.target.value as Op; const meta = OPERATORS.find((o) => o.value === next)!; onChange({ ...rule, op: next, value: meta.needsValue ? rule.value : "" }) }}>
        {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {op.needsValue && <input aria-label="Condition value" className={control} value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })} />}
      <button type="button" onClick={onRemove}>Remove</button>
    </div>
  )
}

function GroupEditor({ group, fields, depth, onChange, onRemoveSelf }: { group: Group; fields: string[]; depth: number; onChange: (g: Group) => void; onRemoveSelf?: () => void }) {
  return (
    <div className="rounded border p-3 space-y-2" style={{ marginLeft: depth * 16 }}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Match</span>
        <select className="rounded border bg-background px-2 py-1 text-sm" value={group.logic} onChange={(e) => onChange({ ...group, logic: e.target.value as "AND" | "OR" })}>
          <option value="AND">ALL of these (AND)</option>
          <option value="OR">ANY of these (OR)</option>
        </select>
        {onRemoveSelf && <button type="button" className="text-xs text-destructive underline" onClick={onRemoveSelf}>Remove group</button>}
      </div>
      {group.children.map((child, i) =>
        isRule(child) ? (
          <RuleRow key={i} rule={child} fields={fields}
            onChange={(r) => onChange({ ...group, children: group.children.map((c, n) => (n === i ? r : c)) })}
            onRemove={() => onChange({ ...group, children: group.children.filter((_, n) => n !== i) })} />
        ) : (
          <GroupEditor key={i} group={child as Group} fields={fields} depth={depth + 1}
            onChange={(g) => onChange({ ...group, children: group.children.map((c, n) => (n === i ? g : c)) })}
            onRemoveSelf={() => onChange({ ...group, children: group.children.filter((_, n) => n !== i) })} />
        ),
      )}
      <div className="flex gap-3">
        <button type="button" className="text-xs underline" disabled={countRules(group) >= 20} onClick={() => onChange({ ...group, children: [...group.children, { field: fields[0], op: "eq", value: "" }] })}>+ Condition</button>
        {depth < 2 && <button type="button" className="text-xs underline" onClick={() => onChange({ ...group, children: [...group.children, { logic: "AND", children: [] }] })}>+ Nested group</button>}
      </div>
    </div>
  )
}

function ActionsEditor({ label, actions, module, onChange }: { label: string; actions: Action[]; module: WorkflowModule; onChange: (a: Action[]) => void }) {
  function update(i: number, patch: Record<string, unknown>) { onChange(actions.map((a, n) => (n === i ? ({ ...a, ...patch } as Action) : a))) }
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{label}</h3>
      {actions.length === 0 && <p className="text-xs text-muted-foreground">No actions in this branch yet.</p>}
      {actions.map((a, i) => (
        <fieldset className="border rounded p-3 space-y-2" key={i}>
          <legend>Step {i + 1}: {a.type}</legend>
          {"userId" in a && <label className="block">{a.type === "approval" ? "Approver" : "Recipient / assignee"} user ID<input type="number" min="1" className={control} value={a.userId || ""} onChange={(e) => update(i, { userId: Number(e.target.value) })} /></label>}
          {"message" in a && <label className="block">Message<input className={control} value={a.message} onChange={(e) => update(i, { message: e.target.value })} /></label>}
          {a.type === "email" && <label className="block">Subject<input className={control} value={a.subject} onChange={(e) => update(i, { subject: e.target.value })} /></label>}
          {a.type === "whatsapp" && <label className="block">Phone (E.164, e.g. +15551234567)<input className={control} value={a.phone} onChange={(e) => update(i, { phone: e.target.value })} /></label>}
          {a.type === "create" && (
            <>
              <label className="block">New workflow task title<input className={control} value={a.title} onChange={(e) => update(i, { title: e.target.value })} /></label>
              <label className="block">Description<textarea className={control} value={a.description} onChange={(e) => update(i, { description: e.target.value })} /></label>
            </>
          )}
          {a.type === "delay" && <label className="block">Delay in seconds<input type="number" min="1" max="2592000" className={control} value={a.seconds} onChange={(e) => update(i, { seconds: Number(e.target.value) })} /></label>}
          {a.type === "schedule" && <label className="block">Resume at (UTC, e.g. 2026-10-01T09:00:00Z)<input className={control} value={a.at} onChange={(e) => update(i, { at: e.target.value })} /></label>}
          {a.type === "webhook" && <label className="block">Configured destination name (ask platform admin)<input className={control} value={a.target} onChange={(e) => update(i, { target: e.target.value })} /></label>}
          {a.type === "update" && (
            <>
              <select aria-label="Update field" className={control} value={a.field} onChange={(e) => update(i, { field: e.target.value, value: e.target.value === "priority" ? "High" : "" })}>
                <option value="priority">Priority</option>
                {module === "workflow_tasks" && <option value="description">Description</option>}
              </select>
              {a.field === "priority" ? (
                <select aria-label="Priority" className={control} value={a.value} onChange={(e) => update(i, { value: e.target.value })}>{["Low", "Medium", "High", "Urgent"].map((v) => <option key={v}>{v}</option>)}</select>
              ) : (
                <textarea aria-label="Description" className={control} value={a.value} onChange={(e) => update(i, { value: e.target.value })} />
              )}
            </>
          )}
          <button type="button" onClick={() => onChange(actions.filter((_, n) => n !== i))}>Remove step</button>
        </fieldset>
      ))}
      <select aria-label={`Add ${label} action`} className={control} value="" disabled={actions.length >= 30} onChange={(e) => onChange([...actions, { ...defaults[e.target.value as Action["type"]] }])}>
        <option value="" disabled>Add an action…</option>
        {Object.keys(defaults).map((k) => <option key={k}>{k}</option>)}
      </select>
    </div>
  )
}

export function WorkflowConsole({ initialRecordId = "" }: { initialRecordId?: string }) {
  const [draft, setDraft] = useState<Workflow>(initial)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [data, setData] = useState<any>({ definitions: [], runs: [], notices: [], tasks: [], events: [], versions: [] })
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false)
  const [workflowId, setWorkflowId] = useState(""), [recordId, setRecordId] = useState(initialRecordId), [at, setAt] = useState("")
  const [requestKey, setRequestKey] = useState("")
  const [previewRecordId, setPreviewRecordId] = useState(""), [previewResult, setPreviewResult] = useState<any>(null), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState("")
  const [resource, setResource] = useState<string>("sales_leads")
  const [triggerChoice, setTriggerChoice] = useState<string>("manual")
  const resourceMeta = RESOURCE_CATALOG.find((r) => r.value === resource)
  const triggerMeta = TRIGGER_CATALOG.find((t) => t.value === triggerChoice)
  const resourceSupported = !!resourceMeta?.module
  const triggerSupported = !!triggerMeta?.trigger
  const whenSupported = resourceSupported && triggerSupported
  async function load() { const r = await fetch("/api/admin/workflows"); const b = await r.json(); if (!r.ok) throw new Error(b.error); setData(b) }
  useEffect(() => { load().catch((e) => setMessage(e.message)); const t = setInterval(() => load().catch(() => {}), 15000); return () => clearInterval(t) }, [])
  async function send(body: unknown) {
    setBusy(true); setMessage("")
    try { const r = await fetch("/api/admin/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const b = await r.json(); if (!r.ok) throw new Error(b.error); setMessage(`Saved${b.id ? ` (#${b.id})` : ""}`); await load(); return true }
    catch (e) { setMessage(e instanceof Error ? e.message : "Request failed"); return false } finally { setBusy(false) }
  }
  function editWorkflow(def: any) {
    const parsed: Workflow = typeof def.definition === "string" ? JSON.parse(def.definition) : def.definition
    setEditingId(def.id)
    setDraft({ ...parsed, description: parsed.description ?? "", elseActions: parsed.elseActions ?? [] })
    setResource(parsed.module)
    setTriggerChoice(parsed.trigger)
    setPreviewResult(null); setPreviewError("")
  }
  function resetDraft() { setEditingId(null); setDraft(initial); setResource("sales_leads"); setTriggerChoice("manual"); setPreviewResult(null); setPreviewError("") }
  async function runPreview() {
    setPreviewBusy(true); setPreviewError(""); setPreviewResult(null)
    try {
      const r = await fetch("/api/admin/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "preview", definition: draft, recordId: Number(previewRecordId) }) })
      const b = await r.json(); if (!r.ok) throw new Error(b.error)
      setPreviewResult(b)
    } catch (e) { setPreviewError(e instanceof Error ? e.message : "Preview failed") } finally { setPreviewBusy(false) }
  }
  const chosen = data.definitions.find((d: any) => String(d.id) === workflowId)
  const definition = chosen ? (typeof chosen.definition === "string" ? JSON.parse(chosen.definition) : chosen.definition) : null
  return (
    <main className="space-y-6 max-w-5xl">
      <h1 className="text-2xl font-semibold">Workflow engine</h1>
      <p>
        Build multi-branch workflows for Sales leads and cross-module workflow tasks: nested AND/OR conditions choose a THEN or
        ELSE branch, and actions (notify, email, WhatsApp, approval, webhook, delay, assign, update, create task) run in order
        through the central scheduler. Dates are UTC; approvals require another designated tenant admin.
      </p>
      <p role="status" className="text-primary">{message}</p>

      <section className="border rounded p-4 space-y-4">
        <div>
          <h2 className="text-xl">WHEN</h2>
          <p className="text-sm text-muted-foreground">
            Choose the resource this workflow watches and what triggers it. Leads and Tasks run on the live
            workflow engine today; the rest of the enterprise catalog is shown for planning and is disabled until
            Codex wires that resource&apos;s backend.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            Module / Resource
            <select
              className={control}
              value={resource}
              disabled={!!editingId}
              onChange={(e) => {
                const next = e.target.value
                setResource(next)
                const meta = RESOURCE_CATALOG.find((r) => r.value === next)
                if (meta?.module) setDraft({ ...draft, module: meta.module, conditions: { logic: "AND", children: [] }, actions: [], elseActions: [] })
              }}
            >
              {RESOURCE_CATALOG.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                  {!r.module ? " (Codex integration required)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Trigger
            <select
              className={control}
              value={triggerChoice}
              onChange={(e) => {
                const next = e.target.value
                setTriggerChoice(next)
                const meta = TRIGGER_CATALOG.find((t) => t.value === next)
                if (meta?.trigger) setDraft({ ...draft, trigger: meta.trigger })
              }}
            >
              {TRIGGER_CATALOG.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                  {!t.trigger ? " (Codex integration required)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!whenSupported && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            This resource/trigger combination is not yet wired to the workflow execution engine. You can still
            design the conditions and actions below, but saving is disabled until the backend supports it.
          </p>
        )}
      </section>

      <section className="border rounded p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl">{editingId ? `Edit workflow #${editingId}` : "IF / THEN / ELSE builder"}</h2>
          {editingId && <button type="button" className="text-xs underline" onClick={resetDraft}>Start a new workflow instead</button>}
        </div>
        <label className="block">Name<input className={control} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="block">Description<textarea className={control} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>

        <h3 className="font-medium">Conditions — evaluated once when the run starts</h3>
        <GroupEditor group={draft.conditions} fields={resourceSupported ? FIELDS[draft.module] : (RESOURCE_FIELDS[resource] ?? FIELDS[draft.module])} depth={0} onChange={(g) => setDraft({ ...draft, conditions: g })} />

        <ActionsEditor label="THEN — runs when conditions match" actions={draft.actions} module={draft.module} onChange={(a) => setDraft({ ...draft, actions: a })} />
        <ActionsEditor label="ELSE — runs when conditions do not match (optional)" actions={draft.elseActions} module={draft.module} onChange={(a) => setDraft({ ...draft, elseActions: a })} />

        <div className="flex gap-2">
          <button className="rounded bg-primary text-primary-foreground px-4 py-2 disabled:opacity-50" disabled={busy || !whenSupported} title={!whenSupported ? "Choose a live resource and trigger (Leads/Tasks, Manual/Scheduled) to save" : undefined} onClick={async () => { if (await send(editingId ? { operation: "update", id: editingId, definition: draft } : { operation: "create", definition: draft })) resetDraft() }}>
            {editingId ? "Save changes (new version)" : "Save workflow"}
          </button>
        </div>
      </section>

      <section className="border rounded p-4 space-y-3">
        <h2 className="text-xl">Test mode — execution preview</h2>
        <p className="text-sm text-muted-foreground">Evaluate the workflow you are editing above against a real record, without running any actions or writing anything.</p>
        <div className="flex items-end gap-2">
          <label className="block">Record ID<input type="number" min="1" className={control} value={previewRecordId} onChange={(e) => setPreviewRecordId(e.target.value)} /></label>
          <button disabled={previewBusy || !previewRecordId} onClick={runPreview}>Preview</button>
        </div>
        {previewError && <p className="text-sm text-destructive">{previewError}</p>}
        {previewResult && (
          <div className="text-sm space-y-1">
            <p>Branch that would run: <strong>{previewResult.matched ? "THEN" : "ELSE"}</strong></p>
            <p>{previewResult.actions.length} action(s) would execute:</p>
            <ul className="list-disc pl-5">{previewResult.actions.map((a: any, i: number) => <li key={i}>{a.type}</li>)}</ul>
          </div>
        )}
      </section>

      <section className="border rounded p-4 space-y-3">
        <h2 className="text-xl">Your workflows</h2>
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead><tr>{["ID", "Name", "Module", "Trigger", "Version", "Status", "Actions"].map((h) => <th className="p-2" key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {data.definitions.map((d: any) => {
                const def = typeof d.definition === "string" ? JSON.parse(d.definition) : d.definition
                return (
                  <tr className="border-t" key={d.id}>
                    <td className="p-2">#{d.id}</td>
                    <td className="p-2">{d.name}{d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}</td>
                    <td className="p-2">{def?.module}</td>
                    <td className="p-2">{def?.trigger}</td>
                    <td className="p-2">v{d.version ?? 1}</td>
                    <td className="p-2">{d.enabled ? "Active" : <span className="text-muted-foreground">Inactive</span>}</td>
                    <td className="p-2 flex gap-2">
                      <button type="button" onClick={() => editWorkflow(d)}>Edit</button>
                      <button type="button" disabled={busy} onClick={() => send({ operation: "toggle", id: d.id, enabled: !d.enabled })}>{d.enabled ? "Disable" : "Enable"}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border rounded p-4 space-y-3">
        <h2 className="text-xl">Run / schedule workflow</h2>
        <label className="block">Workflow<select className={control} value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); setRequestKey("") }}><option value="">Choose…</option>{data.definitions.map((d: any) => <option key={d.id} value={d.id}>#{d.id} {d.name}</option>)}</select></label>
        <label className="block">Existing {definition?.module === "workflow_tasks" ? "workflow task" : "Sales lead"} ID<input type="number" min="1" className={control} value={recordId} onChange={(e) => { setRecordId(e.target.value); setRequestKey("") }} /></label>
        {definition?.trigger === "scheduled" && <label className="block">Run at (ISO UTC date)<input className={control} value={at} placeholder="2026-10-01T09:00:00Z" onChange={(e) => { setAt(e.target.value); setRequestKey("") }} /></label>}
        <button disabled={busy || !workflowId || !recordId} onClick={async () => { const key = requestKey || crypto.randomUUID(); setRequestKey(key); if (await send({ operation: "start", workflowId: Number(workflowId), recordId: Number(recordId), requestKey: key, ...(definition?.trigger === "scheduled" ? { at } : {}) })) setRequestKey("") }}>Start workflow</button>
      </section>

      <section><h2 className="text-xl">Recent runs</h2><div className="overflow-auto"><table className="w-full text-left"><thead><tr>{["Run", "Workflow", "Record", "Branch", "Status", "Step", "Details", "Approval"].map((h) => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{data.runs.map((r: any) => <tr className="border-t" key={r.id}><td className="p-2">{r.id}</td><td>{r.workflow_id}</td><td>{r.record_id}</td><td>{(r.branch || "then").toUpperCase()}</td><td>{r.status}</td><td>{r.cursor + 1}</td><td>{r.error_code || r.available_at}</td><td>{r.status === "approval" && <><button disabled={busy} onClick={() => send({ operation: "decide", runId: Number(r.id), approve: true })}>Approve</button>{" / "}<button disabled={busy} onClick={() => send({ operation: "decide", runId: Number(r.id), approve: false })}>Reject</button></>}</td></tr>)}</tbody></table></div></section>
      <section><h2 className="text-xl">Run definitions & controls</h2>{data.runs.map((r: any) => <details className="border rounded p-3 my-2" key={r.id}><summary>Run #{r.id} · Record #{r.record_id} · {r.status}</summary><p>Review this immutable definition before approving. Cancelling stops remaining actions; it does not undo completed actions.</p><pre className="overflow-auto text-xs my-3">{JSON.stringify(typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot, null, 2)}</pre>{["queued", "waiting", "approval"].includes(r.status) && <button disabled={busy} onClick={() => send({ operation: "cancel", runId: Number(r.id) })}>Cancel remaining actions</button>}</details>)}</section>
      <section><h2 className="text-xl">Workflow version history</h2>{data.versions.map((v: any, i: number) => <p key={i}>Workflow #{v.workflow_id}: v{v.version} · by user #{v.changed_by} · {v.created_at}</p>)}</section>
      <section><h2 className="text-xl">Your workflow notifications</h2>{data.notices.map((n: any) => <p key={n.id}>Run #{n.run_id}: {n.message}</p>)}</section>
      <section><h2 className="text-xl">Created workflow tasks</h2>{data.tasks.map((t: any) => <p key={t.id}>#{t.id} {t.title} · {t.priority} · {t.status} · User #{t.assigned_to} · Source run #{t.source_run_id}</p>)}</section>
      <section><h2 className="text-xl">Recent execution history</h2>{data.events.map((e: any, i: number) => <p key={i}>Run #{e.run_id}, step {e.step + 1}: {e.event_type} · {e.created_at}</p>)}</section>
    </main>
  )
}
