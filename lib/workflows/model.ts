export type WorkflowModule = "sales_leads" | "workflow_tasks"
export type Op = "eq" | "neq" | "contains" | "ncontains" | "gt" | "lt" | "gte" | "lte" | "empty" | "nempty" | "in" | "nin"
export type Rule = { field: string; op: Op; value: string }
export type Group = { logic: "AND" | "OR"; children: (Rule | Group)[] }
export type Action =
  | { type: "notify"; userId: number; message: string }
  | { type: "approval"; userId: number; message: string }
  | { type: "delay"; seconds: number }
  | { type: "schedule"; at: string }
  | { type: "webhook"; target: string }
  | { type: "update"; field: "priority" | "description"; value: string }
  | { type: "assign"; userId: number }
  | { type: "create"; title: string; description: string; userId: number }
  | { type: "email"; userId: number; subject: string; message: string }
  | { type: "whatsapp"; phone: string; message: string }
  | { type: "asset"; assetTag: string; userId: number }
export type WorkflowTrigger = "manual" | "scheduled" | "event"
// Only business events with a live, transactional publisher (see lib/events/model.ts)
// may trigger workflows. Each maps to the module whose record the event carries.
export const TRIGGER_EVENTS = { "deal.won": "sales_leads" } as const satisfies Record<string, WorkflowModule>
export type TriggerEvent = keyof typeof TRIGGER_EVENTS
export type Workflow = {
  name: string
  description: string
  module: WorkflowModule
  trigger: WorkflowTrigger
  eventType?: TriggerEvent
  conditions: Group
  actions: Action[]
  elseActions: Action[]
}
export const FIELDS = { sales_leads: ["status", "lead_status", "priority", "company_name", "lead_source"], workflow_tasks: ["status", "priority", "title"] }
export const OPERATORS: { value: Op; label: string; needsValue: boolean }[] = [
  { value: "eq", label: "Equals", needsValue: true },
  { value: "neq", label: "Does not equal", needsValue: true },
  { value: "contains", label: "Contains", needsValue: true },
  { value: "ncontains", label: "Does not contain", needsValue: true },
  { value: "gt", label: "Greater than", needsValue: true },
  { value: "lt", label: "Less than", needsValue: true },
  { value: "gte", label: "Greater than or equal", needsValue: true },
  { value: "lte", label: "Less than or equal", needsValue: true },
  { value: "empty", label: "Is empty", needsValue: false },
  { value: "nempty", label: "Is not empty", needsValue: false },
  { value: "in", label: "In (comma separated)", needsValue: true },
  { value: "nin", label: "Not in (comma separated)", needsValue: true },
]
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
const text = (s: unknown, max: number) => typeof s === "string" && s.trim().length > 0 && s.length <= max
const optionalText = (s: unknown, max: number) => typeof s === "string" && s.length <= max

export function isRule(n: Rule | Group): n is Rule {
  return !!n && typeof n === "object" && "op" in n
}
export function countRules(g: Group): number {
  return g.children.reduce((n, c) => n + (isRule(c) ? 1 : countRules(c as Group)), 0)
}
function normalizeConditions(c: unknown): Group {
  if (Array.isArray(c)) return { logic: "AND", children: c as Rule[] } // legacy flat-array shape
  if (c && typeof c === "object" && "logic" in (c as any) && "children" in (c as any)) return c as Group
  return { logic: "AND", children: [] }
}
function validateGroup(g: unknown, depth: number, mod: WorkflowModule): Group {
  if (!g || typeof g !== "object" || !("logic" in (g as any)) || !("children" in (g as any))) throw new Error("Invalid condition group")
  const grp = g as Group
  if (!["AND", "OR"].includes(grp.logic)) throw new Error("Invalid group logic")
  if (!Array.isArray(grp.children)) throw new Error("Invalid condition group")
  if (depth > 3) throw new Error("Condition nesting too deep (max 3 levels)")
  const children = grp.children.map((c) => {
    if (c && typeof c === "object" && "op" in (c as any)) {
      const r = c as Rule
      if (!FIELDS[mod].includes(r.field)) throw new Error("Invalid condition field")
      const operator = OPERATORS.find((o) => o.value === r.op)
      if (!operator) throw new Error("Invalid condition operator")
      if (operator.needsValue && (typeof r.value !== "string" || !r.value.trim().length || r.value.length > 500)) throw new Error("Condition value required")
      return { field: r.field, op: r.op, value: operator.needsValue ? r.value : "" } as Rule
    }
    return validateGroup(c, depth + 1, mod)
  })
  if (countRules({ logic: grp.logic, children }) > 20) throw new Error("Use up to 20 conditions in total")
  return { logic: grp.logic, children }
}
function validateActions(actions: unknown, mod: WorkflowModule, label: string): Action[] {
  if (!Array.isArray(actions) || actions.length > 30) throw new Error(`${label} actions: use 0–30 actions`)
  return actions.map((a) => {
    if (!a || typeof a !== "object") throw new Error("Invalid action")
    switch ((a as Action).type) {
      case "notify":
      case "approval": {
        const x = a as { userId: number; message: string }
        if (!positive(x.userId) || !text(x.message, 1000)) throw new Error("Recipient and message required")
        return { type: (a as Action).type, userId: x.userId, message: x.message } as Action
      }
      case "assign": {
        const x = a as { userId: number }
        if (!positive(x.userId)) throw new Error("Assignee required")
        return { type: "assign", userId: x.userId } as Action
      }
      case "create": {
        const x = a as { userId: number; title: string; description: string }
        if (!positive(x.userId) || !text(x.title, 255) || typeof x.description !== "string" || x.description.length > 4000) throw new Error("Invalid task")
        return { type: "create", userId: x.userId, title: x.title, description: x.description } as Action
      }
      case "delay": {
        const x = a as { seconds: number }
        if (!positive(x.seconds) || x.seconds > 2592000) throw new Error("Delay must be 1–2592000 seconds")
        return { type: "delay", seconds: x.seconds } as Action
      }
      case "schedule": {
        const x = a as { at: string }
        if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(x.at) || !Number.isFinite(Date.parse(x.at))) throw new Error("Scheduled action needs an ISO UTC date")
        return { type: "schedule", at: x.at } as Action
      }
      case "webhook": {
        const x = a as { target: string }
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(x.target)) throw new Error("Invalid webhook target name")
        return { type: "webhook", target: x.target } as Action
      }
      case "update": {
        const x = a as { field: string; value: string }
        if (!(x.field === "priority" && ["Low", "Medium", "High", "Urgent"].includes(x.value)) && !(mod === "workflow_tasks" && x.field === "description" && typeof x.value === "string" && x.value.length <= 4000)) throw new Error("Field is not writable by workflows")
        return { type: "update", field: x.field, value: x.value } as Action
      }
      case "email": {
        const x = a as { userId: number; subject: string; message: string }
        if (!positive(x.userId) || !text(x.subject, 255) || !text(x.message, 4000)) throw new Error("Email action needs a recipient, subject and message")
        return { type: "email", userId: x.userId, subject: x.subject, message: x.message } as Action
      }
      case "whatsapp": {
        const x = a as { phone: string; message: string }
        if (!/^\+?[1-9]\d{7,14}$/.test(x.phone) || !text(x.message, 1000)) throw new Error("WhatsApp action needs a valid phone number (E.164) and message")
        return { type: "whatsapp", phone: x.phone, message: x.message } as Action
      }
      case "asset": {
        const x = a as { assetTag: string; userId: number }
        if (!positive(x.userId) || typeof x.assetTag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(x.assetTag)) throw new Error("Asset action needs an asset tag and a recipient")
        return { type: "asset", assetTag: x.assetTag, userId: x.userId } as Action
      }
      default:
        throw new Error("Unsupported action")
    }
  })
}
export function validateWorkflow(value: unknown): Workflow {
  const w = value as Workflow
  if (!w || !text(w.name, 120) || !["sales_leads", "workflow_tasks"].includes(w.module) || !["manual", "scheduled", "event"].includes(w.trigger)) throw new Error("Invalid workflow name, module or trigger")
  if (w.trigger === "event" && (!Object.hasOwn(TRIGGER_EVENTS, w.eventType ?? "") || TRIGGER_EVENTS[w.eventType!] !== w.module)) throw new Error("Choose a business event published by this module")
  if (!optionalText(w.description, 500)) throw new Error("Description is too long")
  const conditions = validateGroup(normalizeConditions(w.conditions), 0, w.module)
  const actions = validateActions(w.actions, w.module, "THEN")
  if (!actions.length) throw new Error("Add at least one THEN action")
  const elseActions = validateActions(w.elseActions ?? [], w.module, "ELSE")
  // Whitelist top-level fields; definitions cannot inject execution state.
  const base: Workflow = { name: w.name.trim(), description: (w.description ?? "").trim(), module: w.module, trigger: w.trigger, conditions, actions, elseActions }
  return w.trigger === "event" ? { ...base, eventType: w.eventType } : base
}
function evalRule(record: Record<string, unknown>, r: Rule): boolean {
  const v = String(record[r.field] ?? "")
  switch (r.op) {
    case "eq": return v === r.value
    case "neq": return v !== r.value
    case "contains": return v.includes(r.value)
    case "ncontains": return !v.includes(r.value)
    case "empty": return v === ""
    case "nempty": return v !== ""
    case "in": return r.value.split(",").map((s) => s.trim()).includes(v)
    case "nin": return !r.value.split(",").map((s) => s.trim()).includes(v)
    case "gt": case "lt": case "gte": case "lte": {
      const a = Number(v), b = Number(r.value)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return r.op === "gt" ? a > b : r.op === "lt" ? a < b : r.op === "gte" ? a >= b : a <= b
    }
    default: return false
  }
}
function evalGroup(record: Record<string, unknown>, g: Group): boolean {
  if (!g.children.length) return true
  const results = g.children.map((c) => (isRule(c) ? evalRule(record, c) : evalGroup(record, c as Group)))
  return g.logic === "AND" ? results.every(Boolean) : results.some(Boolean)
}
export function matches(w: Workflow, record: Record<string, unknown>): boolean {
  return evalGroup(record, normalizeConditions(w.conditions))
}
export function approvalAllowed(requester: number, approver: number, designated: number) { return requester !== approver && approver === designated }

// Publish-time safety gate for the visual automation builder. validateWorkflow
// already whitelists supported ("available") actions and bounds sizes; this
// additionally rejects definitions that could form an execution cycle or an
// unbounded timing loop once a workflow is published and allowed to run.
export function assertPublishable(w: Workflow, ctx?: PublishContext): void {
  const blocking = analyzeWorkflow(w, ctx ?? OPEN_CONTEXT).filter((i) => i.severity === "error")
  if (blocking.length) throw new Error(blocking[0].message)
}

// Everything the analyzer needs to know about the tenant's live environment.
// Supplied by the server; the client can never assert availability itself.
export type PublishContext = {
  actorId: number
  webhookTargets: string[]
  emailConfigured: boolean
  whatsappConfigured: boolean
  activeMembers: number[]
  adminMembers: number[]
}
const OPEN_CONTEXT: PublishContext = { actorId: 0, webhookTargets: [], emailConfigured: true, whatsappConfigured: true, activeMembers: [], adminMembers: [] }
export type Issue = { severity: "error" | "warning"; code: string; message: string; branch?: "then" | "else"; step?: number }
const MAX_TOTAL_WAIT_SECONDS = 90 * 86400
// Actions a workflow on each module could perform that would publish the event
// that triggers it. "deal.won" is only published by markLeadWon; no workflow
// action can change a lead's status, so there is currently no event self-loop,
// but the table keeps the guard explicit if writable fields grow.
const EVENT_EFFECTS: Record<TriggerEvent, (a: Action) => boolean> = {
  "deal.won": (a) => a.type === "update" && (a.field as string) === "status",
}

// Static safety analysis for the visual builder. Errors block publish; warnings
// are surfaced in the editor. Pure: no I/O, deterministic, unit-testable.
export function analyzeWorkflow(w: Workflow, ctx: PublishContext): Issue[] {
  const issues: Issue[] = []
  const checkContext = ctx !== OPEN_CONTEXT
  const branches: ["then" | "else", Action[]][] = [["then", w.actions], ["else", w.elseActions]]
  if (!w.actions.length) issues.push({ severity: "error", code: "empty_then", message: "Publish requires at least one THEN action" })
  for (const [branch, actions] of branches) {
    let waitSeconds = 0, waits = 0
    actions.forEach((a, i) => {
      const at = { branch, step: i + 1 }
      // Cycle guard: "create" inserts an erp_workflow_tasks record, exactly what
      // the workflow_tasks module watches; a Tasks workflow creating tasks could re-trigger itself.
      if (w.module === "workflow_tasks" && a.type === "create") issues.push({ severity: "error", code: "cycle", message: "Cycle detected: a Tasks workflow cannot create workflow tasks", ...at })
      if (w.trigger === "event" && w.eventType && EVENT_EFFECTS[w.eventType](a)) issues.push({ severity: "error", code: "cycle", message: `Cycle detected: this step would re-publish ${w.eventType}`, ...at })
      if (a.type === "delay") { waits++; waitSeconds += a.seconds }
      if (a.type === "schedule") { waits++; if (w.trigger !== "manual") issues.push({ severity: "warning", code: "fixed_schedule", message: "A fixed resume date is reached once; later runs will resume immediately", ...at }) }
      if (!checkContext) return
      if (a.type === "webhook" && !ctx.webhookTargets.includes(a.target)) issues.push({ severity: "error", code: "unavailable_action", message: `Webhook destination "${a.target}" is not configured for this tenant`, ...at })
      // Mail may be configured through tenant settings the analyzer cannot see, so this only warns.
      if (a.type === "email" && !ctx.emailConfigured) issues.push({ severity: "warning", code: "unavailable_action", message: "No deployment mail transport detected; email steps may fail", ...at })
      if (a.type === "whatsapp" && !ctx.whatsappConfigured) issues.push({ severity: "error", code: "unavailable_action", message: "WhatsApp integration is not connected for this tenant", ...at })
      if ("userId" in a) {
        if (a.type === "approval") {
          if (!ctx.adminMembers.includes(a.userId)) issues.push({ severity: "error", code: "permission", message: `Approver #${a.userId} must be an active tenant admin`, ...at })
          // Event-triggered runs are requested by the publisher, so they could never approve their own run.
          else if (a.userId === ctx.actorId) issues.push({ severity: w.trigger === "event" ? "error" : "warning", code: "self_approval", message: "The approver cannot be the person who starts the run; choose another admin", ...at })
        } else if (!ctx.activeMembers.includes(a.userId)) issues.push({ severity: "error", code: "permission", message: `User #${a.userId} is not an active member of this tenant`, ...at })
      }
    })
    // Timing-loop guard: cap chained waits and total wait time per branch.
    if (waits > 10) issues.push({ severity: "error", code: "timing_loop", message: "Too many delay/schedule steps; possible timing loop", branch })
    if (waitSeconds > MAX_TOTAL_WAIT_SECONDS) issues.push({ severity: "error", code: "timing_loop", message: "Total delay exceeds 90 days", branch })
  }
  return issues
}

export type SimulationStep = { branch: "then" | "else"; step: number; type: Action["type"]; outcome: "executes" | "pauses" | "waits" | "external" | "blocked"; detail: string }
export type Simulation = { matched: boolean; branch: "then" | "else" | null; steps: SimulationStep[]; issues: Issue[]; completes: boolean }

// Walks the chosen branch exactly as the engine would, without side effects.
// Approvals are assumed granted so later steps are still shown; blocked steps
// stop the walk because the engine would fail the run there.
export function simulateWorkflow(w: Workflow, record: Record<string, unknown>, ctx: PublishContext, now = Date.now()): Simulation {
  const issues = analyzeWorkflow(w, ctx)
  const matched = matches(w, record)
  const branch = matched ? "then" : w.elseActions.length ? "else" : null
  const steps: SimulationStep[] = []
  if (!branch) return { matched, branch, steps, issues, completes: true }
  const blocked = new Map(issues.filter((i) => i.severity === "error" && i.branch === branch && i.step).map((i) => [i.step!, i.message]))
  let clock = now, completes = true
  for (const [i, a] of (branch === "then" ? w.actions : w.elseActions).entries()) {
    const base = { branch, step: i + 1, type: a.type }
    if (blocked.has(i + 1)) { steps.push({ ...base, outcome: "blocked", detail: blocked.get(i + 1)! }); completes = false; break }
    switch (a.type) {
      case "approval": steps.push({ ...base, outcome: "pauses", detail: `Waits for approval by user #${a.userId}; rejection ends the run` }); break
      case "delay": clock += a.seconds * 1000; steps.push({ ...base, outcome: "waits", detail: `Resumes at ${new Date(clock).toISOString()}` }); break
      case "schedule": clock = Math.max(clock, Date.parse(a.at)); steps.push({ ...base, outcome: "waits", detail: `Resumes at ${new Date(clock).toISOString()}` }); break
      case "webhook": steps.push({ ...base, outcome: "external", detail: `Delivers to "${a.target}" once; never retried automatically` }); break
      case "email": steps.push({ ...base, outcome: "external", detail: `Emails user #${a.userId}: "${a.subject}"` }); break
      case "whatsapp": steps.push({ ...base, outcome: "external", detail: `Sends WhatsApp to ${a.phone}` }); break
      case "update": steps.push({ ...base, outcome: "executes", detail: `Sets ${a.field} from "${String(record[a.field] ?? "")}" to "${a.value}"` }); break
      case "assign": steps.push({ ...base, outcome: "executes", detail: `Reassigns from #${String(record.assigned_to ?? "none")} to #${a.userId}` }); break
      case "create": steps.push({ ...base, outcome: "executes", detail: `Creates task "${a.title}" for user #${a.userId}` }); break
      case "notify": steps.push({ ...base, outcome: "executes", detail: `Notifies user #${a.userId}` }); break
      case "asset": steps.push({ ...base, outcome: "executes", detail: `Records asset ${a.assetTag} assigned to user #${a.userId}` }); break
    }
  }
  return { matched, branch, steps, issues, completes }
}
