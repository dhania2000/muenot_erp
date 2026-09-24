"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { Plus, Pencil, Trash2, Search, X } from "lucide-react"
import { toast } from "sonner"
import { Checkbox } from "@/components/ui/checkbox"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { OperationsSopHistory } from "@/components/operations/operations-sop-history"
import { OperationsChecklistItems } from "@/components/operations/operations-checklist-items"
import { CallButtons } from "@/components/calls/call-button"
import { useResolvedEmployees, type ResolveItem } from "@/components/calls/use-resolved-employees"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import {
  Users,
  FolderKanban,
  Layers,
  Gauge,
  BatteryCharging,
  AlertTriangle,
  ShieldCheck,
  Star,
  ShieldAlert,
  UserCog,
  UsersRound,
} from "lucide-react"

const fetcherJson = (url: string) => fetch(url).then((r) => r.json())

const configs: Record<string, { title: string; fields: string[] }> = {
  resources: {
    title: "Resources",
    fields: ["resource_name", "resource_type", "department", "designation", "skill_category", "primary_skills", "secondary_skills", "employment_status", "joining_date", "exit_date", "current_location", "work_mode", "availability_status", "cost_rate", "rate_type", "reporting_manager", "personal_email", "official_email", "contact_mobile", "vendor_agency", "shift", "status", "remarks"],
  },
  projects: {
    title: "Projects",
    fields: ["client_id", "client_name", "project_name", "service_vertical", "project_type", "project_manager", "operations_manager", "start_date", "end_date", "status", "billing_model", "budget_amount", "required_resources", "allocated_resources", "resources_deficiency", "sla_target", "priority", "shift", "work_mode", "client_poc", "client_email", "client_contact", "remarks"],
  },
  allocations: {
    title: "Allocations",
    fields: ["resource_id", "resource_name", "resource_type", "project_id", "client_name", "role", "from_date", "to_date", "shift", "working_capacity", "allocated_capacity", "available_capacity", "status", "project_manager", "operations_manager", "remarks"],
  },
  quality: {
    title: "Quality & SLA Reviews",
    fields: ["task_id", "project_id", "client_name", "resource_id", "resource_name", "resource_type", "review_date", "quality_score", "quality_target", "error_rate", "rework_count", "sla_target", "sla_actual", "sla_status", "client_escalation", "root_cause", "corrective_action", "action_owner", "action_due_date", "closure_date", "status", "remarks"],
  },
  issues: {
    title: "Issues",
    fields: ["date_reported", "project_id", "client_name", "issue_type", "issue_category", "priority", "description", "impact", "reported_by", "assigned_to", "root_cause", "corrective_action", "preventive_action", "target_date", "closure_date", "status", "escalation_level", "client_impact", "business_impact", "remarks"],
  },
  milestones: {
    title: "Project Milestones",
    fields: ["project_id", "project_name", "milestone_name", "description", "owner", "planned_start", "planned_end", "actual_start", "actual_end", "completion_percent", "priority", "status", "remarks"],
  },
  deliverables: {
    title: "Project Deliverables",
    fields: ["project_id", "project_name", "deliverable_name", "milestone_id", "description", "deliverable_type", "owner", "due_date", "submitted_date", "accepted_date", "version", "quality_status", "status", "remarks"],
  },
  project_documents: {
    title: "Project Documents",
    fields: ["project_id", "project_name", "document_name", "document_type", "category", "version", "owner", "document_url", "effective_date", "expiry_date", "confidentiality", "status", "remarks"],
  },
  tasks: {
    title: "Tasks",
    fields: ["project_id", "project_name", "client_name", "task_title", "description", "task_type", "assigned_to", "resource_id", "resource_name", "milestone_id", "milestone_name", "reporter", "priority", "start_date", "due_date", "estimated_hours", "actual_hours", "completion_percent", "board_stage", "status", "remarks"],
  },
  work_orders: {
    title: "Work Orders",
    fields: ["work_order_no", "project_id", "task_id", "client_name", "title", "description", "instructions", "work_type", "assigned_to", "resource_id", "resource_name", "requested_by", "priority", "start_date", "due_date", "estimated_cost", "actual_cost", "status", "remarks"],
  },
  resource_requests: {
    title: "Resource Requests",
    fields: ["project_id", "project_name", "requested_by", "resource_type", "skill_category", "required_skills", "quantity", "allocation_percent", "required_from", "required_to", "priority", "justification", "approver", "status", "remarks"],
  },
  skill_matrix: {
    title: "Skill Matrix",
    fields: ["resource_id", "resource_name", "department", "skill_category", "skill_name", "proficiency_level", "experience_years", "certification", "last_assessed", "assessed_by", "status", "remarks"],
  },
  capacity_planning: {
    title: "Capacity Planning",
    fields: ["period", "department", "resource_type", "project_id", "planned_capacity", "allocated_capacity", "available_capacity", "demand_forecast", "utilization_target", "owner", "status", "remarks"],
  },
  utilization: {
    title: "Utilization",
    fields: ["resource_id", "resource_name", "project_id", "period", "billable_hours", "non_billable_hours", "available_hours", "utilization_percent", "billable_percent", "target_utilization", "status", "remarks"],
  },
  timesheets: {
    title: "Timesheet Management",
    fields: ["resource_id", "resource_name", "project_id", "project_name", "task_id", "work_date", "start_time", "end_time", "hours_worked", "billable_hours", "non_billable_hours", "activity_type", "description", "approved_by", "approval_status", "status", "remarks"],
  },
  qa_audits: {
    title: "QA Audits",
    fields: ["audit_no", "project_id", "client_name", "audit_type", "audit_scope", "auditor", "audit_date", "findings", "non_conformities", "severity", "score", "corrective_action_required", "closure_date", "status", "remarks"],
  },
  sla_monitoring: {
    title: "SLA Monitoring",
    fields: ["project_id", "client_name", "sla_metric", "sla_target", "actual_value", "unit", "measurement_period", "due_date", "actual_completion", "delay_days", "breach_count", "penalty", "owner", "review_date", "sla_status", "status", "remarks"],
  },
  corrective_actions: {
    title: "Corrective Actions",
    fields: ["reference_no", "project_id", "source_type", "issue_summary", "root_cause", "corrective_action", "preventive_action", "action_owner", "target_date", "closure_date", "effectiveness", "status", "remarks"],
  },
  escalations: {
    title: "Escalations",
    fields: ["escalation_no", "project_id", "client_name", "raised_by", "escalation_level", "category", "description", "impact", "assigned_to", "raised_date", "target_resolution", "resolution", "closure_date", "status", "remarks"],
  },
  root_cause_capa: {
    title: "Root Cause / CAPA",
    fields: ["reference_no", "project_id", "problem_statement", "analysis_method", "root_cause", "capa_type", "corrective_action", "preventive_action", "owner", "target_date", "verification_date", "effectiveness", "status", "remarks"],
  },
  sops: {
    title: "SOPs",
    fields: ["sop_code", "title", "category", "department", "version", "description", "owner", "effective_date", "review_date", "next_review_date", "approval_status", "document_url", "status", "remarks"],
  },
  checklists: {
    title: "Checklists",
    fields: ["checklist_name", "category", "project_id", "linked_sop", "description", "total_items", "completed_items", "owner", "due_date", "completion_percent", "status", "remarks"],
  },
  approvals: {
    title: "Approvals",
    fields: ["approval_no", "request_type", "related_to", "project_id", "requested_by", "approver", "request_date", "priority", "description", "decision", "decision_date", "status", "remarks"],
  },
  client_requirements: {
    title: "Client Requirements",
    fields: ["client_name", "project_id", "requirement_title", "description", "requirement_type", "priority", "source", "owner", "received_date", "target_date", "acceptance_criteria", "status", "remarks"],
  },
  client_deliverables: {
    title: "Client Deliverables",
    fields: ["client_name", "project_id", "deliverable_name", "description", "deliverable_type", "owner", "due_date", "submitted_date", "acceptance_date", "acceptance_status", "version", "status", "remarks"],
  },
  client_approvals: {
    title: "Client Approvals",
    fields: ["client_name", "project_id", "approval_item", "description", "submitted_to", "submitted_date", "approver_name", "decision", "decision_date", "feedback", "status", "remarks"],
  },
  project_cost: {
    title: "Project Cost",
    fields: ["project_id", "project_name", "client_name", "cost_category", "cost_head", "budgeted_cost", "actual_cost", "committed_cost", "variance", "currency", "period", "cost_date", "status", "remarks"],
  },
  resource_cost: {
    title: "Resource Cost",
    fields: ["resource_id", "resource_name", "project_id", "cost_type", "rate", "rate_type", "hours", "period", "total_cost", "currency", "billable", "status", "remarks"],
  },
  vendor_cost: {
    title: "Vendor Cost",
    fields: ["vendor_name", "project_id", "service_category", "po_number", "description", "invoice_amount", "paid_amount", "currency", "invoice_date", "due_date", "payment_status", "status", "remarks"],
  },
  budget_vs_actual: {
    title: "Budget vs Actual",
    fields: ["project_id", "project_name", "client_name", "category", "budget_amount", "actual_amount", "variance", "variance_percent", "period", "currency", "forecast_amount", "status", "remarks"],
  },
  productivity: {
    title: "Productivity",
    fields: ["resource_id", "resource_name", "project_id", "period", "tasks_assigned", "tasks_completed", "deliverables_completed", "estimated_hours", "logged_hours", "billable_hours", "task_completion_percent", "efficiency_percent", "billable_percent", "productivity_score", "source", "status", "remarks"],
  },
  scorecards: {
    title: "Quality Scorecards",
    fields: ["scorecard_no", "scorecard_type", "subject_type", "subject_id", "subject_name", "project_id", "client_name", "period", "review_date", "reviewer", "total_score", "max_score", "score_percent", "result", "status", "remarks"],
  },
  scorecard_criteria: {
    title: "Scorecard Criteria",
    fields: ["scorecard_id", "criteria_name", "weight", "max_score", "score", "weighted_score", "status", "remarks"],
  },
  teams: {
    title: "Teams",
    fields: ["team_name", "team_code", "team_type", "department", "team_lead", "project_id", "project_name", "client_name", "member_count", "capacity_hours", "allocated_hours", "location", "work_mode", "shift", "status", "remarks"],
  },
  revenue: {
    title: "Project Revenue",
    fields: ["project_id", "project_name", "client_name", "revenue_type", "billing_model", "invoice_no", "description", "amount", "recognized_amount", "billed_amount", "received_amount", "currency", "revenue_date", "period", "recognition_status", "status", "remarks"],
  },
  risks: {
    title: "Risk Register",
    fields: ["project_id", "project_name", "client_name", "risk_title", "description", "risk_category", "probability", "impact", "risk_score", "risk_level", "risk_owner", "mitigation_plan", "contingency_plan", "identified_date", "review_date", "target_date", "closure_date", "status", "remarks"],
  },
}

// Default lifecycle statuses used when a module has no specialised set.
const DEFAULT_STATUS = ["Active", "In Progress", "On Hold", "Completed", "Closed"]

// Per-module status lifecycles. Projects use the full delivery lifecycle
// (Phase 5): Draft → Planned → Active → On Hold → Completed → Closed → Cancelled.
const STATUS_BY_KIND: Record<string, string[]> = {
  projects: ["Draft", "Planned", "Active", "On Hold", "Completed", "Closed", "Cancelled"],
  issues: ["Open", "Assigned", "In Progress", "Blocked", "Resolved", "Closed", "Reopened"],
  escalations: ["Open", "Assigned", "In Progress", "Blocked", "Resolved", "Closed", "Reopened"],
  approvals: ["Pending", "Approved", "Rejected"],
  client_approvals: ["Pending", "Approved", "Rejected"],
  tasks: ["To Do", "In Progress", "Blocked", "In Review", "Done"],
  allocations: ["Active", "Partially Allocated", "Over Allocated", "Completed", "Released"],
  timesheets: ["Draft", "Submitted", "Approved", "Rejected"],
  corrective_actions: ["Open", "In Progress", "Closed", "Verified"],
  root_cause_capa: ["Open", "In Progress", "Closed", "Verified"],
  qa_audits: ["Planned", "In Progress", "Completed", "Closed"],
  work_orders: ["Open", "In Progress", "On Hold", "Completed", "Cancelled"],
  resource_requests: ["Open", "Approved", "Fulfilled", "Rejected", "Cancelled"],
  teams: ["Active", "Forming", "On Hold", "Disbanded"],
  revenue: ["Forecast", "Committed", "Invoiced", "Received", "Written Off"],
  risks: ["Open", "Assessed", "Mitigating", "Monitoring", "Closed", "Occurred"],
}

// Fixed option lists for enum-style fields shared across modules. Any field not
// listed here (and not "status") renders as a free text / date input.
const ENUM_OPTIONS: Record<string, string[]> = {
  priority: ["Low", "Medium", "High", "Critical"],
  board_stage: ["Backlog", "To Do", "In Progress", "In Review", "Done"],
  work_mode: ["On-site", "Hybrid", "Remote"],
  shift: ["General", "Morning", "Evening", "Night"],
  rate_type: ["Hourly", "Daily", "Monthly", "Fixed"],
  resource_type: ["FTE", "Contractor", "Freelancer", "Vendor"],
  employment_status: ["FTE", "Contractor", "Freelancer"],
  availability_status: ["Available", "Partially Allocated", "Fully Allocated", "Unavailable"],
  billable: ["Yes", "No"],
  billing_model: ["Fixed", "T&M", "Milestone", "Retainer"],
  confidentiality: ["Public", "Internal", "Confidential", "Restricted"],
  approval_status: ["Pending", "Approved", "Rejected"],
  acceptance_status: ["Pending", "Accepted", "Rejected", "Rework"],
  quality_status: ["Pending", "Accepted", "Rejected", "Rework"],
  payment_status: ["Unpaid", "Partially Paid", "Paid"],
  severity: ["Low", "Medium", "High", "Critical"],
  sla_status: ["Met SLA", "At Risk", "Breached SLA"],
  escalation_level: ["L1", "L2", "L3"],
  decision: ["Approved", "Rejected", "On Hold", "Pending"],
  proficiency_level: ["Beginner", "Intermediate", "Advanced", "Expert"],
  capa_type: ["Corrective", "Preventive"],
  scorecard_type: ["Resource", "Project", "Client", "Vendor"],
  subject_type: ["Resource", "Project", "Client", "Vendor"],
  result: ["Excellent", "Satisfactory", "Needs Improvement", "Poor"],
  source: ["derived", "manual"],
}

// Per-module overrides for enum fields whose option list differs from the
// shared ENUM_OPTIONS default. Timesheets follow the approval lifecycle
// Draft → Submitted → Approved → Rejected (Phase 18), while other modules that
// expose `approval_status` keep the simpler Pending/Approved/Rejected set.
const ENUM_BY_KIND: Record<string, Record<string, string[]>> = {
  timesheets: {
    approval_status: ["Draft", "Submitted", "Approved", "Rejected"],
  },
  teams: {
    team_type: ["Delivery", "Support", "QA", "Management", "Cross-functional"],
  },
  revenue: {
    revenue_type: ["Milestone", "Time & Material", "Fixed Fee", "Retainer", "Change Request", "Other"],
    recognition_status: ["Pending", "Recognized", "Deferred", "Invoiced", "Received"],
  },
  risks: {
    risk_category: ["Technical", "Financial", "Operational", "Schedule", "Resource", "Compliance", "Security", "External"],
    probability: ["Low", "Medium", "High"],
    impact: ["Low", "Medium", "High"],
    risk_level: ["Low", "Medium", "High", "Critical"],
  },
}

// Fields that are computed automatically by the server and must not be edited
// by hand (e.g. SLA delay is derived from due date vs. actual completion).
const READONLY_FIELDS = new Set(["delay_days", "risk_score", "risk_level"])

// Fields that render as a time picker rather than a text input.
const TIME_FIELDS = new Set(["start_time", "end_time"])

// Extra date fields whose name does not literally contain "date".
const DATE_FIELDS = new Set(["actual_completion"])

// Returns the select options for a field within a module, or null for a plain input.
function optionsFor(kind: string, field: string): string[] | null {
  if (field === "status") return STATUS_BY_KIND[kind] ?? DEFAULT_STATUS
  return ENUM_BY_KIND[kind]?.[field] ?? ENUM_OPTIONS[field] ?? null
}

// Columns that render as a coloured status Badge in the list view.
const BADGE_FIELDS = new Set(["status", "sla_status", "priority", "approval_status", "payment_status", "severity", "risk_level", "recognition_status"])

function formatCell(value: any): string {
  if (value == null || String(value).trim() === "") return "—"
  return String(value).slice(0, 60)
}

function recordId(row: any): string {
  return String(
    row.id ?? row.resource_id ?? row.project_id ?? row.allocation_id ?? row.review_id ?? row.issue_id ?? "",
  )
}

// Modules whose rows represent a person we can resolve to an HR Employee Master
// record and therefore attach the reusable internal call action to: the
// Resource master itself, Allocations (project members) and Tasks / Work Orders
// (task assignees) — Phase 60/87-89/93.
const CALLABLE_KINDS = new Set(["resources", "allocations", "tasks", "work_orders"])

// Extract the loosely-linked identifiers for a row so the server can resolve it
// to a callable HR employee. Resources carry their own employee code + emails;
// allocations/tasks carry a resource_id into operations_resources plus a name.
function callResolveItem(kind: string, row: any): ResolveItem | null {
  const key = recordId(row)
  if (!key) return null
  if (kind === "resources") {
    return {
      key,
      code: row.employee_id ?? null,
      email: row.official_email || row.personal_email || null,
      name: row.resource_name || null,
    }
  }
  const name = row.resource_name || row.assigned_to || null
  if (row.resource_id == null && !name) return null
  return { key, resourceId: row.resource_id ?? null, name }
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  "Over Allocated": "destructive",
  "Breached SLA": "destructive",
  Open: "secondary",
  "In Progress": "secondary",
  "Not Evaluated": "outline",
  Active: "default",
  Resolved: "default",
  Closed: "default",
  "Met SLA": "default",
  "Partially Allocated": "outline",
}

export function OperationsOverview() {
  const { data, isLoading } = useSWR("/api/operations/dashboard", fetcherJson, { refreshInterval: 30000 })
  const { data: monitoring } = useSWR<{
    counts: Record<string, number>
    alerts: { category: string; title: string; due_date: string | null; owner: string | null; link: string }[]
    progress: {
      project_id: number
      project_name: string | null
      client_name: string | null
      progress: number
      overdue_tasks: number
      status: string | null
    }[]
  }>("/api/operations/monitoring", fetcherJson, { refreshInterval: 30000 })

  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground">Loading operations dashboard...</div>
  }

  const { kpis, resourceType, allocationStatus, slaStatus, issueStatus } = data

  const primaryKpis = [
    { label: "Active Resources", value: kpis.activeResources, icon: Users },
    { label: "Active Projects", value: kpis.activeProjects, icon: FolderKanban },
    { label: "Total Allocations", value: kpis.totalAllocations, icon: Layers },
    { label: "Allocated Capacity", value: `${kpis.allocatedCapacity} hrs`, icon: Gauge },
    { label: "Available Capacity", value: `${kpis.availableCapacity} hrs`, icon: BatteryCharging },
    { label: "Open Issues", value: kpis.openIssues, icon: AlertTriangle },
  ]

  const secondaryKpis = [
    { label: "Quality Reviews", value: kpis.qualityReviews, icon: ShieldCheck },
    { label: "Avg Quality", value: kpis.avgQuality, icon: Star },
    { label: "SLA Breached", value: kpis.slaBreached, icon: ShieldAlert },
    { label: "Over Allocated", value: kpis.overAllocated, icon: AlertTriangle },
    { label: "FTE", value: kpis.fte, icon: UserCog },
    { label: "Freelancer + Contractor", value: kpis.nonFte, icon: UsersRound },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {primaryKpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {secondaryKpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {monitoring && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base">Deadlines & Alerts</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {Object.keys(monitoring.counts).length === 0 ? (
                <p className="text-sm text-muted-foreground">No overdue or pending items. All clear.</p>
              ) : (
                Object.entries(monitoring.counts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([category, count]) => (
                    <div key={category} className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{category}</span>
                      <Badge variant={/overdue|breach/i.test(category) ? "destructive" : "outline"}>{count}</Badge>
                    </div>
                  ))
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Project Progress</CardTitle>
            </CardHeader>
            <CardContent>
              {monitoring.progress.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Project</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead className="w-40">Progress</TableHead>
                      <TableHead className="text-right">Overdue Tasks</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monitoring.progress.slice(0, 8).map((p) => (
                      <TableRow key={p.project_id}>
                        <TableCell className="font-medium">{p.project_name ?? `#${p.project_id}`}</TableCell>
                        <TableCell className="text-muted-foreground">{p.client_name ?? "—"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${Math.min(100, Math.max(0, p.progress))}%` }}
                              />
                            </div>
                            <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                              {p.progress}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {p.overdue_tasks > 0 ? (
                            <Badge variant="destructive">{p.overdue_tasks}</Badge>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resource Type</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resourceType.map((row: any) => (
                  <TableRow key={row.type}>
                    <TableCell>{row.type}</TableCell>
                    <TableCell>{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allocation Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allocationStatus.map((row: any) => (
                  <TableRow key={row.status}>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">SLA Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slaStatus.map((row: any) => (
                  <TableRow key={row.status}>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Issue Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issueStatus.map((row: any) => (
                  <TableRow key={row.status}>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function formatLabel(field: string) {
  return field.replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase())
}

type Mode = "create" | "edit"

export function OperationsDashboardClient({ initialModule = "resources" }: { initialModule?: string }) {
  const [kind] = useState(initialModule)
  const [form, setForm] = useState<any>({})
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>("create")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkStatus, setBulkStatus] = useState("")
  const [bulkAssignee, setBulkAssignee] = useState("")
  const [bulkBusy, setBulkBusy] = useState(false)
  const { data, mutate } = useSWR<{ rows: any[] }>(`/api/operations?kind=${kind}`, fetcher)
  const c = configs[kind]

  function openCreate() {
    setMode("create")
    setEditingId(null)
    setForm({})
    setOpen(true)
  }

  function openEdit(row: any) {
    if (!c) return
    setMode("edit")
    setEditingId(String(row.id))
    const next: any = {}
    for (const f of c.fields) next[f] = row[f] ?? ""
    setForm(next)
    setOpen(true)
  }

  async function save() {
    setSaving(true)
    try {
      const isEdit = mode === "edit" && editingId
      await fetch("/api/operations", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEdit ? { kind, id: editingId, ...form } : { kind, ...form }),
      })
      setForm({})
      setOpen(false)
      setEditingId(null)
      setMode("create")
      mutate()
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: any) {
    const id = row?.id
    if (id == null) return
    if (!window.confirm("Delete this record? This action cannot be undone.")) return
    setDeletingId(String(id))
    try {
      await fetch(`/api/operations?kind=${kind}&id=${encodeURIComponent(String(id))}`, { method: "DELETE" })
      mutate()
    } finally {
      setDeletingId(null)
    }
  }

  const allRows: any[] = data?.rows || []
  const term = search.trim().toLowerCase()
  const rows: any[] = term
    ? allRows.filter((row) =>
        Object.values(row).some((v) => v != null && String(v).toLowerCase().includes(term)),
      )
    : allRows
  const columns = c ? c.fields.slice(0, 6) : []

  // Resolve visible rows to callable HR employees in one batch request.
  const callableItems: ResolveItem[] = CALLABLE_KINDS.has(kind)
    ? rows.map((r) => callResolveItem(kind, r)).filter((x): x is ResolveItem => x != null)
    : []
  const callTargets = useResolvedEmployees(callableItems)

  // Which bulk transitions are meaningful for this kind, derived from its fields.
  const fieldSet = new Set(c?.fields ?? [])
  const canApproveReject = fieldSet.has("approval_status") || fieldSet.has("decision")
  const canAssign = ["assigned_to", "action_owner", "owner", "approver"].some((f) => fieldSet.has(f))
  const statusOptions = STATUS_BY_KIND[kind] ?? DEFAULT_STATUS

  const visibleIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const selectedRows = allRows.filter((r) => selected.has(Number(r.id)))

  function toggleRow(id: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleAll(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelected(new Set())
    setBulkStatus("")
    setBulkAssignee("")
  }

  async function runBulk(action: string, value?: string) {
    const ids = [...selected]
    if (!ids.length) return
    if (action === "delete" && !window.confirm(`Delete ${ids.length} selected record(s)? This cannot be undone.`)) return
    setBulkBusy(true)
    try {
      const res = await fetch("/api/operations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ids, action, value }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json?.error ?? "Bulk action failed")
        return
      }
      const parts = [`${json.succeeded ?? 0} updated`]
      if (json.forbidden) parts.push(`${json.forbidden} not permitted`)
      if (json.skipped) parts.push(`${json.skipped} skipped`)
      toast.success(parts.join(", "))
      clearSelection()
      mutate()
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Delivery cockpit</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {kind === "overview" ? "Operations" : c?.title ?? "Operations"}
          </h1>
        </div>

        {kind !== "overview" && c && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder={`Search ${c.title.toLowerCase()}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-48 pl-8 sm:w-64"
                aria-label={`Search ${c.title}`}
              />
            </div>
            <ExcelExportButton
              rows={rows}
              filename={kind}
              columns={c.fields.map((f) => ({ header: formatLabel(f), value: (r: any) => r[f] }))}
            />
            <ImportButton moduleKey={`operations-${kind}`} onImported={() => mutate()} />
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              Add {c.title}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                  <DialogTitle>
                    {mode === "edit" ? "Edit" : "Add"} {c.title}
                  </DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-2 md:grid-cols-2">
                  {c.fields.map((field: string) => {
                    const opts = optionsFor(kind, field)
                    return (
                      <div key={field} className="flex flex-col gap-1.5">
                        <Label htmlFor={field} className="text-xs text-muted-foreground">
                          {formatLabel(field)}
                        </Label>
                        {opts ? (
                          <select
                            id={field}
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                            value={form[field] ?? ""}
                            onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                          >
                            <option value="">Select {formatLabel(field)}</option>
                            {opts.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            id={field}
                            placeholder={
                              READONLY_FIELDS.has(field) ? "Auto-calculated" : formatLabel(field)
                            }
                            type={
                              TIME_FIELDS.has(field)
                                ? "time"
                                : field.includes("date") || DATE_FIELDS.has(field)
                                  ? "date"
                                  : "text"
                            }
                            readOnly={READONLY_FIELDS.has(field)}
                            disabled={READONLY_FIELDS.has(field)}
                            value={form[field] ?? ""}
                            onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline">Cancel</Button>} />
                  <Button onClick={save} disabled={saving}>
                    {saving ? "Saving..." : mode === "edit" ? "Update record" : "Save record"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>

      {kind === "overview" && <OperationsOverview />}

      {kind !== "overview" && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value)}
            aria-label="Bulk status"
            disabled={bulkBusy}
          >
            <option value="">Set status...</option>
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkBusy || !bulkStatus}
            onClick={() => runBulk("status", bulkStatus)}
          >
            Apply
          </Button>
          {canApproveReject && (
            <>
              <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => runBulk("approve")}>
                Approve
              </Button>
              <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => runBulk("reject")}>
                Reject
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => runBulk("close")}>
            Close
          </Button>
          {canAssign && (
            <div className="flex items-center gap-1">
              <Input
                placeholder="Assign to..."
                value={bulkAssignee}
                onChange={(e) => setBulkAssignee(e.target.value)}
                className="h-9 w-36"
                disabled={bulkBusy}
                aria-label="Assign selected to"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy || !bulkAssignee.trim()}
                onClick={() => runBulk("assign", bulkAssignee.trim())}
              >
                Assign
              </Button>
            </div>
          )}
          <ExcelExportButton
            rows={selectedRows}
            filename={`${kind}-selected`}
            columns={c!.fields.map((f) => ({ header: formatLabel(f), value: (r: any) => r[f] }))}
            label="Export Selected"
            size="sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={bulkBusy}
            onClick={() => runBulk("delete")}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
          <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={clearSelection}>
            <X className="size-4" />
            Clear
          </Button>
        </div>
      )}

      {kind !== "overview" && (
        <section className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-3">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(v) => toggleAll(v === true)}
                    aria-label="Select all rows"
                    disabled={visibleIds.length === 0}
                  />
                </th>
                <th className="p-3">ID</th>
                {columns.map((col) => (
                  <th key={col} className="whitespace-nowrap p-3">
                    {formatLabel(col)}
                  </th>
                ))}
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 3} className="p-8 text-center text-muted-foreground">
                    {term
                      ? `No ${c?.title.toLowerCase()} match "${search.trim()}".`
                      : `No records yet. Click "Add ${c?.title}" to create one.`}
                  </td>
                </tr>
              )}
              {rows.map((row: any, i: number) => (
                <tr key={row.id ?? i} className="border-b transition-colors last:border-0 hover:bg-muted/40">
                  <td className="p-3">
                    <Checkbox
                      checked={selected.has(Number(row.id))}
                      onCheckedChange={(v) => toggleRow(Number(row.id), v === true)}
                      aria-label="Select row"
                      disabled={!Number.isFinite(Number(row.id)) || Number(row.id) <= 0}
                    />
                  </td>
                  <td className="p-3 font-mono text-xs">{row.id ?? recordId(row)}</td>
                  {columns.map((col) => (
                    <td key={col} className="p-3">
                      {BADGE_FIELDS.has(col) && row[col] ? (
                        <Badge variant={STATUS_VARIANT[row[col]] ?? "outline"}>{row[col]}</Badge>
                      ) : (
                        <span className="line-clamp-1">{formatCell(row[col])}</span>
                      )}
                    </td>
                  ))}
                  <td className="p-3">
                    <div className="flex items-center justify-end gap-1">
                      {CALLABLE_KINDS.has(kind) &&
                        (() => {
                          const t = callTargets[recordId(row)]
                          if (!t || !t.active) return null
                          return (
                            <CallButtons
                              target={{
                                employeeId: t.employeeId,
                                name: t.name,
                                origin: `operations_${kind}`,
                                projectId: Number(row.project_id) || null,
                                projectName: row.project_name || null,
                                taskId: Number(row.task_id) || null,
                                taskName: row.task_title || null,
                              }}
                            />
                          )
                        })()}
                      {kind === "sops" && row.id != null && (
                        <OperationsSopHistory sopId={row.id} title={row.title} />
                      )}
                      {kind === "checklists" && row.id != null && (
                        <OperationsChecklistItems
                          checklistId={row.id}
                          name={row.checklist_name}
                          onChange={() => mutate()}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Edit record"
                        onClick={() => openEdit(row)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Delete record"
                        className="text-destructive hover:text-destructive"
                        disabled={deletingId === String(row.id)}
                        onClick={() => remove(row)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  )
}
