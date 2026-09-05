"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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
    fields: ["client_id", "client_name", "project_name", "service_vertical", "project_type", "project_manager", "operations_manager", "start_date", "end_date", "status", "billing_model", "required_resources", "allocated_resources", "resources_deficiency", "sla_target", "priority", "shift", "work_mode", "client_poc", "client_email", "client_contact", "remarks"],
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

export function OperationsDashboardClient({ initialModule = "resources" }: { initialModule?: string }) {
  const [kind, setKind] = useState(initialModule)
  const [form, setForm] = useState<any>({})
  const { data, mutate } = useSWR(`/api/operations?kind=${kind}`, fetcher)
  const c = configs[kind]

  async function save() {
    await fetch("/api/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...form }),
    })
    setForm({})
    mutate()
  }

  return (
    <main className="space-y-8 p-6">
      <div>
        <p className="text-sm text-muted-foreground">Delivery cockpit</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {kind === "overview" ? "Operations" : c?.title ?? "Operations"}
        </h1>
      </div>

      {kind === "overview" && <OperationsOverview />}

      {kind !== "overview" && <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-lg font-semibold">Add {c.title}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {c.fields.map((field: string) => (
            <Input
              key={field}
              placeholder={field.replaceAll("_", " ")}
              type={field.includes("date") ? "date" : "text"}
              value={form[field] ?? ""}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
            />
          ))}
        </div>
        <Button className="mt-4" onClick={save}>
          Save record
        </Button>
      </section>}

      {kind !== "overview" && <section className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="p-4">ID</th>
              <th className="p-4">Record</th>
              <th className="p-4">Status</th>
              <th className="p-4">Created</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((row: any) => (
              <tr
                key={row.resource_id || row.project_id || row.allocation_id || row.review_id || row.issue_id}
                className="border-b last:border-0"
              >
                <td className="p-4 font-mono text-xs">
                  {row.resource_id || row.project_id || row.allocation_id || row.review_id || row.issue_id}
                </td>
                <td className="p-4">{row.resource_name || row.project_name || row.title || row.reviewer_name || "Operational record"}</td>
                <td className="p-4">{row.status}</td>
                <td className="p-4 text-muted-foreground">{String(row.created_at || "").slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>}
    </main>
  )
}
