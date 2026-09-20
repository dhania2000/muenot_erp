export type WorkflowModule = "sales_leads" | "workflow_tasks"
export type Rule = { field: string; op: "eq" | "neq" | "contains"; value: string }
export type Action =
  | { type: "notify"; userId: number; message: string }
  | { type: "approval"; userId: number; message: string }
  | { type: "delay"; seconds: number }
  | { type: "schedule"; at: string }
  | { type: "webhook"; target: string }
  | { type: "update"; field: "priority" | "description"; value: string }
  | { type: "assign"; userId: number }
  | { type: "create"; title: string; description: string; userId: number }
export type Workflow = { name: string; module: WorkflowModule; trigger: "manual" | "scheduled"; conditions: Rule[]; actions: Action[] }
export const FIELDS = { sales_leads: ["status", "lead_status", "priority", "company_name", "lead_source"], workflow_tasks: ["status", "priority", "title"] }
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
export function validateWorkflow(value: unknown): Workflow {
  const w = value as Workflow
  const text = (s: unknown, max: number) => typeof s === "string" && s.trim().length > 0 && s.length <= max
  if (!w || !text(w.name, 120) || !["sales_leads", "workflow_tasks"].includes(w.module) || !["manual", "scheduled"].includes(w.trigger)) throw new Error("Invalid workflow name, module or trigger")
  if (!Array.isArray(w.conditions) || w.conditions.length > 20 || !Array.isArray(w.actions) || !w.actions.length || w.actions.length > 30) throw new Error("Use up to 20 conditions and 1–30 actions")
  for (const r of w.conditions) if (!r || !FIELDS[w.module].includes(r.field) || !["eq", "neq", "contains"].includes(r.op) || typeof r.value !== "string" || r.value.length > 500) throw new Error("Invalid condition")
  for (const a of w.actions) {
    if (!a || typeof a !== "object") throw new Error("Invalid action")
    switch (a.type) {
      case "notify": case "approval": if (!positive(a.userId) || !text(a.message, 1000)) throw new Error("Recipient and message required"); break
      case "assign": if (!positive(a.userId)) throw new Error("Assignee required"); break
      case "create": if (!positive(a.userId) || !text(a.title, 255) || typeof a.description !== "string" || a.description.length > 4000) throw new Error("Invalid task"); break
      case "delay": if (!positive(a.seconds) || a.seconds > 2592000) throw new Error("Delay must be 1–2592000 seconds"); break
      case "schedule": if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(a.at) || !Number.isFinite(Date.parse(a.at))) throw new Error("Scheduled action needs an ISO UTC date"); break
      case "webhook": if (!/^[a-z][a-z0-9_-]{0,63}$/.test(a.target)) throw new Error("Invalid webhook target name"); break
      case "update": if (!(a.field === "priority" && ["Low", "Medium", "High", "Urgent"].includes(a.value)) && !(w.module === "workflow_tasks" && a.field === "description" && typeof a.value === "string" && a.value.length <= 4000)) throw new Error("Field is not writable by workflows"); break
      default: throw new Error("Unsupported action")
    }
  }
  // Whitelist top-level fields; definitions cannot inject execution state.
  return { name: w.name.trim(), module: w.module, trigger: w.trigger, conditions: w.conditions, actions: w.actions }
}
export function matches(w: Workflow, record: Record<string, unknown>): boolean {
  return w.conditions.every(r => { const v = String(record[r.field] ?? ""); return r.op === "eq" ? v === r.value : r.op === "neq" ? v !== r.value : v.includes(r.value) })
}
export function approvalAllowed(requester: number, approver: number, designated: number) { return requester !== approver && approver === designated }
