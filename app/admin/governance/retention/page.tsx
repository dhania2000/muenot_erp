import { Timer, Plus } from "lucide-react"
import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// SPEC 71 — General ERP Data Retention Engine (UI). Generalizes retention
// beyond storage files to any ERP record type, with legal-hold awareness.
const POLICIES = [
  {
    module: "HR",
    recordType: "Terminated employee records",
    period: "7 years",
    action: "Archive",
    nextRun: "2026-10-01",
    lastRun: "2026-09-01",
    affected: 0,
    status: "Active",
    legalHold: false,
  },
  {
    module: "Finance",
    recordType: "Closed invoices",
    period: "10 years",
    action: "Archive",
    nextRun: "2026-10-01",
    lastRun: "2026-09-01",
    affected: 214,
    status: "Active",
    legalHold: false,
  },
  {
    module: "CRM",
    recordType: "Lost leads",
    period: "2 years",
    action: "Delete",
    nextRun: "2026-10-15",
    lastRun: "—",
    affected: 0,
    status: "Active",
    legalHold: false,
  },
  {
    module: "Projects",
    recordType: "Completed project files",
    period: "5 years",
    action: "Archive",
    nextRun: "Paused",
    lastRun: "2026-08-14",
    affected: 3,
    status: "Held (legal hold)",
    legalHold: true,
  },
]

export default function RetentionPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data governance</h1>
        <p className="text-sm text-muted-foreground">
          Central tenant audit log, classification, field security, retention, legal holds, and import/export
          centers.
        </p>
      </header>

      <GovernanceTabs />

      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Timer className="size-4 text-muted-foreground" />
              Retention policies
            </CardTitle>
            <CardDescription>
              Runs as a scheduled, tenant-scoped background job. Every policy checks active legal holds before
              archiving or deleting a record.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5">
            <Plus className="size-3.5" />
            New policy
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Record type</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Affected</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {POLICIES.map((p, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {p.module}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{p.recordType}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.period}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.action}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.nextRun}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.lastRun}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.affected}</TableCell>
                  <TableCell>
                    <Badge variant={p.legalHold ? "destructive" : "secondary"} className="text-[10px]">
                      {p.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
