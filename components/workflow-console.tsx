"use client"
import { useEffect, useState } from "react"
import {
  Bell,
  CheckCircle2,
  Clock,
  GitBranch,
  History,
  Mail,
  MessageCircle,
  PenLine,
  Play,
  Plus,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Webhook,
  X,
  Zap,
} from "lucide-react"
import { FIELDS, OPERATORS, countRules, isRule, type Action, type Group, type Op, type Rule, type Workflow, type WorkflowModule } from "@/lib/workflows/model"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Label } from "@/components/ui/label"

const initial: Workflow = { name: "", description: "", module: "sales_leads", trigger: "manual", conditions: { logic: "AND", children: [] }, actions: [], elseActions: [] }
const control = "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
const selectControl = control + " appearance-none"

const ACTION_META: Record<Action["type"], { label: string; icon: typeof Bell }> = {
  notify: { label: "Notify", icon: Bell },
  approval: { label: "Approval", icon: UserCheck },
  delay: { label: "Delay", icon: Clock },
  schedule: { label: "Schedule", icon: Clock },
  webhook: { label: "Webhook", icon: Webhook },
  update: { label: "Update field", icon: PenLine },
  assign: { label: "Assign", icon: UserPlus },
  create: { label: "Create task", icon: Plus },
  email: { label: "Email", icon: Mail },
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
}

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
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/60 p-2">
      <select aria-label="Condition field" className={selectControl + " sm:w-40"} value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value })}>
        {fields.map((f) => <option key={f}>{f}</option>)}
      </select>
      <select aria-label="Comparison" className={selectControl + " sm:w-36"} value={rule.op} onChange={(e) => { const next = e.target.value as Op; const meta = OPERATORS.find((o) => o.value === next)!; onChange({ ...rule, op: next, value: meta.needsValue ? rule.value : "" }) }}>
        {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {op.needsValue && <Input aria-label="Condition value" className="h-9 flex-1 sm:min-w-32" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })} />}
      <Button type="button" variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label="Remove condition">
        <X className="size-4" />
      </Button>
    </div>
  )
}

function GroupEditor({ group, fields, depth, onChange, onRemoveSelf }: { group: Group; fields: string[]; depth: number; onChange: (g: Group) => void; onRemoveSelf?: () => void }) {
  return (
    <div className={`space-y-2 rounded-lg border ${depth === 0 ? "border-border bg-muted/30" : "border-dashed border-border/70"} p-3`} style={{ marginLeft: depth * 16 }}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Match</span>
        <select className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30" value={group.logic} onChange={(e) => onChange({ ...group, logic: e.target.value as "AND" | "OR" })}>
          <option value="AND">ALL of these (AND)</option>
          <option value="OR">ANY of these (OR)</option>
        </select>
        {onRemoveSelf && (
          <Button type="button" variant="ghost" size="xs" className="ml-auto text-destructive hover:bg-destructive/10" onClick={onRemoveSelf}>
            <Trash2 className="size-3.5" /> Remove group
          </Button>
        )}
      </div>
      {group.children.length === 0 && <p className="text-xs text-muted-foreground">No conditions yet — this branch will always match.</p>}
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
      <div className="flex gap-2 pt-1">
        <Button type="button" variant="outline" size="xs" disabled={countRules(group) >= 20} onClick={() => onChange({ ...group, children: [...group.children, { field: fields[0], op: "eq", value: "" }] })}>
          <Plus className="size-3.5" /> Condition
        </Button>
        {depth < 2 && (
          <Button type="button" variant="outline" size="xs" onClick={() => onChange({ ...group, children: [...group.children, { logic: "AND", children: [] }] })}>
            <GitBranch className="size-3.5" /> Nested group
          </Button>
        )}
      </div>
    </div>
  )
}

function ActionsEditor({ label, tone, actions, module, onChange }: { label: string; tone: "then" | "else"; actions: Action[]; module: WorkflowModule; onChange: (a: Action[]) => void }) {
  function update(i: number, patch: Record<string, unknown>) { onChange(actions.map((a, n) => (n === i ? ({ ...a, ...patch } as Action) : a))) }
  return (
    <div className="space-y-2.5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Badge variant={tone === "then" ? "default" : "secondary"} className="uppercase tracking-wide">{tone}</Badge>
        {label}
      </h3>
      {actions.length === 0 && <p className="text-xs text-muted-foreground">No actions in this branch yet.</p>}
      {actions.map((a, i) => {
        const meta = ACTION_META[a.type]
        const Icon = meta.icon
        return (
          <fieldset className="space-y-2 rounded-lg border border-border/70 bg-background/60 p-3" key={i}>
            <legend className="flex w-full items-center gap-2 pb-1 text-sm font-medium">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="size-3.5" /></span>
              Step {i + 1}: {meta.label}
              <Button type="button" variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => onChange(actions.filter((_, n) => n !== i))} aria-label="Remove step">
                <Trash2 className="size-3.5" />
              </Button>
            </legend>
            {"userId" in a && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{a.type === "approval" ? "Approver" : "Recipient / assignee"} user ID</span>
                <Input type="number" min="1" value={a.userId || ""} onChange={(e) => update(i, { userId: Number(e.target.value) })} />
              </Label>
            )}
            {"message" in a && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Message</span>
                <Input value={a.message} onChange={(e) => update(i, { message: e.target.value })} />
              </Label>
            )}
            {a.type === "email" && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Subject</span>
                <Input value={a.subject} onChange={(e) => update(i, { subject: e.target.value })} />
              </Label>
            )}
            {a.type === "whatsapp" && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Phone (E.164, e.g. +15551234567)</span>
                <Input value={a.phone} onChange={(e) => update(i, { phone: e.target.value })} />
              </Label>
            )}
            {a.type === "create" && (
              <>
                <Label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">New workflow task title</span>
                  <Input value={a.title} onChange={(e) => update(i, { title: e.target.value })} />
                </Label>
                <Label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">Description</span>
                  <Textarea value={a.description} onChange={(e) => update(i, { description: e.target.value })} />
                </Label>
              </>
            )}
            {a.type === "delay" && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Delay in seconds</span>
                <Input type="number" min="1" max="2592000" value={a.seconds} onChange={(e) => update(i, { seconds: Number(e.target.value) })} />
              </Label>
            )}
            {a.type === "schedule" && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Resume at (UTC, e.g. 2026-10-01T09:00:00Z)</span>
                <Input value={a.at} onChange={(e) => update(i, { at: e.target.value })} />
              </Label>
            )}
            {a.type === "webhook" && (
              <Label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Configured destination name (ask platform admin)</span>
                <Input value={a.target} onChange={(e) => update(i, { target: e.target.value })} />
              </Label>
            )}
            {a.type === "update" && (
              <>
                <Label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">Field to update</span>
                  <select aria-label="Update field" className={selectControl} value={a.field} onChange={(e) => update(i, { field: e.target.value, value: e.target.value === "priority" ? "High" : "" })}>
                    <option value="priority">Priority</option>
                    {module === "workflow_tasks" && <option value="description">Description</option>}
                  </select>
                </Label>
                {a.field === "priority" ? (
                  <select aria-label="Priority" className={selectControl} value={a.value} onChange={(e) => update(i, { value: e.target.value })}>{["Low", "Medium", "High", "Urgent"].map((v) => <option key={v}>{v}</option>)}</select>
                ) : (
                  <Textarea aria-label="Description" value={a.value} onChange={(e) => update(i, { value: e.target.value })} />
                )}
              </>
            )}
          </fieldset>
        )
      })}
      <select aria-label={`Add ${label} action`} className={selectControl + " sm:w-56"} value="" disabled={actions.length >= 30} onChange={(e) => onChange([...actions, { ...defaults[e.target.value as Action["type"]] }])}>
        <option value="" disabled>+ Add an action…</option>
        {Object.keys(defaults).map((k) => <option key={k} value={k}>{ACTION_META[k as Action["type"]].label}</option>)}
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
    <main className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Zap className="size-5" />
        </span>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Workflow engine</h1>
          <p className="text-sm text-muted-foreground">
            Build multi-branch workflows for Sales leads and cross-module workflow tasks: nested AND/OR conditions choose a
            THEN or ELSE branch, and actions (notify, email, WhatsApp, approval, webhook, delay, assign, update, create task)
            run in order through the central scheduler. Dates are UTC; approvals require another designated tenant admin.
          </p>
        </div>
      </div>

      {message && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>WHEN</CardTitle>
          <CardDescription>
            Choose the resource this workflow watches and what triggers it. Leads and Tasks run on the live workflow engine
            today; the rest of the enterprise catalog is shown for planning and is disabled until Codex wires that
            resource&apos;s backend.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Label className="block space-y-1.5">
            <span className="text-sm font-medium">Module / Resource</span>
            <select
              className={selectControl}
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
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-sm font-medium">Trigger</span>
            <select
              className={selectControl}
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
          </Label>
          {!whenSupported && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertTitle>Not yet wired to the execution engine</AlertTitle>
              <AlertDescription>
                You can still design the conditions and actions below, but saving is disabled until the backend supports
                this resource/trigger combination.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{editingId ? `Edit workflow #${editingId}` : "IF / THEN / ELSE builder"}</CardTitle>
            {editingId && <Button type="button" variant="ghost" size="xs" onClick={resetDraft}>Start a new workflow instead</Button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="block space-y-1.5">
              <span className="text-sm font-medium">Name</span>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Label>
            <Label className="block space-y-1.5">
              <span className="text-sm font-medium">Description</span>
              <Textarea className="min-h-9" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Label>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Conditions — evaluated once when the run starts</h3>
            <GroupEditor group={draft.conditions} fields={resourceSupported ? FIELDS[draft.module] : (RESOURCE_FIELDS[resource] ?? FIELDS[draft.module])} depth={0} onChange={(g) => setDraft({ ...draft, conditions: g })} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <ActionsEditor label="Runs when conditions match" tone="then" actions={draft.actions} module={draft.module} onChange={(a) => setDraft({ ...draft, actions: a })} />
            <ActionsEditor label="Runs when conditions do not match (optional)" tone="else" actions={draft.elseActions} module={draft.module} onChange={(a) => setDraft({ ...draft, elseActions: a })} />
          </div>
        </CardContent>
        <CardFooter className="justify-between bg-transparent border-t border-border/60">
          <Button disabled={busy || !whenSupported} title={!whenSupported ? "Choose a live resource and trigger (Leads/Tasks, Manual/Scheduled) to save" : undefined} onClick={async () => { if (await send(editingId ? { operation: "update", id: editingId, definition: draft } : { operation: "create", definition: draft })) resetDraft() }}>
            {editingId ? "Save changes (new version)" : "Save workflow"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> Test mode — execution preview</CardTitle>
          <CardDescription>Evaluate the workflow you are editing above against a real record, without running any actions or writing anything.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <Label className="block flex-1 space-y-1.5 sm:max-w-48">
              <span className="text-sm font-medium">Record ID</span>
              <Input type="number" min="1" value={previewRecordId} onChange={(e) => setPreviewRecordId(e.target.value)} />
            </Label>
            <Button variant="outline" disabled={previewBusy || !previewRecordId} onClick={runPreview}>
              <Play className="size-3.5" /> Preview
            </Button>
          </div>
          {previewError && <p className="text-sm text-destructive">{previewError}</p>}
          {previewResult && (
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
              <p className="flex items-center gap-2">
                Branch that would run:
                <Badge variant={previewResult.matched ? "default" : "secondary"} className="uppercase">{previewResult.matched ? "THEN" : "ELSE"}</Badge>
              </p>
              <p>{previewResult.actions.length} action(s) would execute:</p>
              <ul className="flex flex-wrap gap-1.5">
                {previewResult.actions.map((a: any, i: number) => (
                  <li key={i}><Badge variant="outline">{ACTION_META[a.type as Action["type"]]?.label ?? a.type}</Badge></li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your workflows</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>{["ID", "Name", "Module", "Trigger", "Version", "Status", "Actions"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {data.definitions.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No workflows yet — build one above.</TableCell></TableRow>
                )}
                {data.definitions.map((d: any) => {
                  const def = typeof d.definition === "string" ? JSON.parse(d.definition) : d.definition
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">#{d.id}</TableCell>
                      <TableCell>{d.name}{d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}</TableCell>
                      <TableCell>{def?.module}</TableCell>
                      <TableCell>{def?.trigger}</TableCell>
                      <TableCell>v{d.version ?? 1}</TableCell>
                      <TableCell>{d.enabled ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}</TableCell>
                      <TableCell>
                        <div className="flex gap-1.5">
                          <Button type="button" variant="outline" size="xs" onClick={() => editWorkflow(d)}>Edit</Button>
                          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => send({ operation: "toggle", id: d.id, enabled: !d.enabled })}>{d.enabled ? "Disable" : "Enable"}</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run / schedule workflow</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Label className="block space-y-1.5">
            <span className="text-sm font-medium">Workflow</span>
            <select className={selectControl} value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); setRequestKey("") }}>
              <option value="">Choose…</option>
              {data.definitions.map((d: any) => <option key={d.id} value={d.id}>#{d.id} {d.name}</option>)}
            </select>
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-sm font-medium">Existing {definition?.module === "workflow_tasks" ? "workflow task" : "Sales lead"} ID</span>
            <Input type="number" min="1" value={recordId} onChange={(e) => { setRecordId(e.target.value); setRequestKey("") }} />
          </Label>
          {definition?.trigger === "scheduled" && (
            <Label className="block space-y-1.5">
              <span className="text-sm font-medium">Run at (ISO UTC date)</span>
              <Input value={at} placeholder="2026-10-01T09:00:00Z" onChange={(e) => { setAt(e.target.value); setRequestKey("") }} />
            </Label>
          )}
          <Button disabled={busy || !workflowId || !recordId} onClick={async () => { const key = requestKey || crypto.randomUUID(); setRequestKey(key); if (await send({ operation: "start", workflowId: Number(workflowId), recordId: Number(recordId), requestKey: key, ...(definition?.trigger === "scheduled" ? { at } : {}) })) setRequestKey("") }}>
            <Play className="size-3.5" /> Start workflow
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><History className="size-4 text-primary" /> Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="runs">
            <TabsList>
              <TabsTrigger value="runs">Recent runs</TabsTrigger>
              <TabsTrigger value="controls">Run controls</TabsTrigger>
              <TabsTrigger value="versions">Versions</TabsTrigger>
              <TabsTrigger value="notices">Notifications</TabsTrigger>
              <TabsTrigger value="tasks">Created tasks</TabsTrigger>
              <TabsTrigger value="events">Execution history</TabsTrigger>
            </TabsList>

            <TabsContent value="runs" className="pt-3">
              <div className="overflow-auto rounded-lg border border-border/60">
                <Table>
                  <TableHeader>
                    <TableRow>{["Run", "Workflow", "Record", "Branch", "Status", "Step", "Details", "Approval"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.runs.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">No runs yet.</TableCell></TableRow>}
                    {data.runs.map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell>{r.id}</TableCell>
                        <TableCell>{r.workflow_id}</TableCell>
                        <TableCell>{r.record_id}</TableCell>
                        <TableCell><Badge variant="outline" className="uppercase">{r.branch || "then"}</Badge></TableCell>
                        <TableCell>{r.status}</TableCell>
                        <TableCell>{r.cursor + 1}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.error_code || r.available_at}</TableCell>
                        <TableCell>
                          {r.status === "approval" && (
                            <div className="flex gap-1.5">
                              <Button size="xs" disabled={busy} onClick={() => send({ operation: "decide", runId: Number(r.id), approve: true })}>Approve</Button>
                              <Button size="xs" variant="outline" disabled={busy} onClick={() => send({ operation: "decide", runId: Number(r.id), approve: false })}>Reject</Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="controls" className="space-y-2 pt-3">
              {data.runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
              {data.runs.map((r: any) => (
                <details className="rounded-lg border border-border/60 p-3" key={r.id}>
                  <summary className="cursor-pointer text-sm font-medium">Run #{r.id} · Record #{r.record_id} · {r.status}</summary>
                  <p className="pt-2 text-xs text-muted-foreground">Review this immutable definition before approving. Cancelling stops remaining actions; it does not undo completed actions.</p>
                  <pre className="my-3 overflow-auto rounded-md bg-muted/50 p-3 text-xs">{JSON.stringify(typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot, null, 2)}</pre>
                  {["queued", "waiting", "approval"].includes(r.status) && (
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => send({ operation: "cancel", runId: Number(r.id) })}>Cancel remaining actions</Button>
                  )}
                </details>
              ))}
            </TabsContent>

            <TabsContent value="versions" className="space-y-1.5 pt-3 text-sm">
              {data.versions.length === 0 && <p className="text-muted-foreground">No version history yet.</p>}
              {data.versions.map((v: any, i: number) => <p key={i}>Workflow #{v.workflow_id}: v{v.version} · by user #{v.changed_by} · {v.created_at}</p>)}
            </TabsContent>

            <TabsContent value="notices" className="space-y-1.5 pt-3 text-sm">
              {data.notices.length === 0 && <p className="text-muted-foreground">No notifications yet.</p>}
              {data.notices.map((n: any) => <p key={n.id}>Run #{n.run_id}: {n.message}</p>)}
            </TabsContent>

            <TabsContent value="tasks" className="space-y-1.5 pt-3 text-sm">
              {data.tasks.length === 0 && <p className="text-muted-foreground">No workflow tasks created yet.</p>}
              {data.tasks.map((t: any) => <p key={t.id}>#{t.id} {t.title} · {t.priority} · {t.status} · User #{t.assigned_to} · Source run #{t.source_run_id}</p>)}
            </TabsContent>

            <TabsContent value="events" className="space-y-1.5 pt-3 text-sm">
              {data.events.length === 0 && <p className="text-muted-foreground">No execution history yet.</p>}
              {data.events.map((e: any, i: number) => <p key={i}>Run #{e.run_id}, step {e.step + 1}: {e.event_type} · {e.created_at}</p>)}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  )
}
