import { Lock, Plus } from "lucide-react"
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

// SPEC 70 — Field-Level Security (UI). Server-enforced field access policies
// scoped by role / department / legal entity / permission group, applied to
// API responses, UI, exports, and reports.
const EFFECTS: Record<string, "secondary" | "outline" | "destructive"> = {
  Visible: "secondary",
  "Read Only": "outline",
  Masked: "outline",
  Hidden: "destructive",
}

const POLICIES = [
  {
    module: "HR",
    entity: "Employee",
    field: "Salary (CTC)",
    scope: "Role: Manager",
    effect: "Masked",
  },
  {
    module: "HR",
    entity: "Employee",
    field: "Bank account number",
    scope: "Role: Employee",
    effect: "Hidden",
  },
  {
    module: "HR",
    entity: "Employee",
    field: "PAN",
    scope: "Department: Finance",
    effect: "Visible",
  },
  {
    module: "Finance",
    entity: "Payment",
    field: "Bank routing details",
    scope: "Permission group: AP Clerk",
    effect: "Read Only",
  },
  {
    module: "CRM",
    entity: "Customer",
    field: "Contact phone",
    scope: "Legal entity: EU",
    effect: "Masked",
  },
]

export default function FieldSecurityPage() {
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
              <Lock className="size-4 text-muted-foreground" />
              Field access policies
            </CardTitle>
            <CardDescription>
              Enforced server-side on API responses, UI rendering, exports, and reports — never frontend-only
              masking.
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
                <TableHead>Entity</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Effect</TableHead>
                <TableHead className="text-right">Actions</TableHead>
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
                  <TableCell className="text-sm">{p.entity}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.field}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.scope}</TableCell>
                  <TableCell>
                    <Badge variant={EFFECTS[p.effect]} className="text-[10px]">
                      {p.effect}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm">
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sensitive field examples covered</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5 pt-0">
          {["Salary", "Bank details", "PAN", "Tax information", "Personal identifiers", "Internal finance data"].map(
            (t) => (
              <Badge key={t} variant="outline" className="text-[10px]">
                {t}
              </Badge>
            ),
          )}
        </CardContent>
      </Card>
    </div>
  )
}
