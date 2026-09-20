import { Scale, Plus } from "lucide-react"
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

// SPEC 72 — Generic Legal Hold (UI). Extends legal hold beyond files to
// Documents, HR, Finance, CRM, Projects, and other ERP record types.
// Retention/deletion jobs must always check active holds before acting.
const HOLDS = [
  {
    name: "Litigation — Vendor dispute #2291",
    scope: "Finance",
    records: "Vendor VEN-0044, all POs & invoices 2024–2026",
    createdBy: "legal.counsel@acme.com",
    start: "2026-07-12",
    status: "Active",
    releasedBy: null,
  },
  {
    name: "Regulatory inquiry — Payroll audit",
    scope: "HR",
    records: "Filter: department = Finance, period = FY2025",
    createdBy: "compliance@acme.com",
    start: "2026-08-01",
    status: "Active",
    releasedBy: null,
  },
  {
    name: "Contract dispute — Client X",
    scope: "Projects",
    records: "Project PRJ-2201, all deliverables & documents",
    createdBy: "legal.counsel@acme.com",
    start: "2026-05-20",
    status: "Released",
    releasedBy: "legal.counsel@acme.com (2026-08-30, dispute settled)",
  },
]

export default function LegalHoldsPage() {
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
              <Scale className="size-4 text-muted-foreground" />
              Legal holds
            </CardTitle>
            <CardDescription>
              Active holds block retention archive/delete jobs and destructive bulk actions across every covered
              module.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5">
            <Plus className="size-3.5" />
            New hold
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hold</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HOLDS.map((h, i) => (
                <TableRow key={i}>
                  <TableCell className="text-sm font-medium">{h.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {h.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[16rem] text-xs text-muted-foreground">{h.records}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.createdBy}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.start}</TableCell>
                  <TableCell>
                    <Badge variant={h.status === "Active" ? "destructive" : "secondary"} className="text-[10px]">
                      {h.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {h.status === "Active" ? (
                      <Button variant="ghost" size="sm">
                        Release
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Released</span>
                    )}
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
