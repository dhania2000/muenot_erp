import { Tag, Plus } from "lucide-react"
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

// SPEC 69 — General Data Classification (UI). Generalizes classification
// beyond Finance to any module/entity/record/field, with the five standard
// sensitivity levels used elsewhere in the governance suite.
const LEVELS = [
  { level: "Public", tone: "secondary" as const, description: "No restriction. Safe for any audience." },
  { level: "Internal", tone: "outline" as const, description: "Employees only. Not for external sharing." },
  { level: "Confidential", tone: "outline" as const, description: "Restricted to a defined business need." },
  { level: "Restricted", tone: "destructive" as const, description: "Named roles only, logged access." },
  { level: "Highly Restricted", tone: "destructive" as const, description: "Named individuals only, dual control." },
]

const MAPPINGS = [
  { module: "HR", entity: "Employee", field: "Bank account number", level: "Highly Restricted" },
  { module: "HR", entity: "Employee", field: "PAN / tax ID", level: "Restricted" },
  { module: "HR", entity: "Employee", field: "Salary (CTC)", level: "Restricted" },
  { module: "Finance", entity: "Invoice", field: "Line-item pricing", level: "Confidential" },
  { module: "CRM", entity: "Customer", field: "Contact email", level: "Internal" },
  { module: "Sales", entity: "Deal", field: "Deal value", level: "Confidential" },
  { module: "Storage", entity: "File", field: "Entire record", level: "Public" },
]

function levelTone(level: string): "secondary" | "outline" | "destructive" {
  return LEVELS.find((l) => l.level === level)?.tone ?? "outline"
}

export default function ClassificationPage() {
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

      <div className="grid gap-3 sm:grid-cols-5">
        {LEVELS.map((l) => (
          <Card key={l.level}>
            <CardContent className="flex flex-col gap-1.5 pt-4">
              <Badge variant={l.tone} className="w-fit text-[10px]">
                {l.level}
              </Badge>
              <p className="text-xs text-muted-foreground">{l.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Tag className="size-4 text-muted-foreground" />
              Classification mappings
            </CardTitle>
            <CardDescription>
              Maps a module / entity / field combination to a sensitivity level. Feeds field security, exports,
              retention, and legal hold enforcement.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5">
            <Plus className="size-3.5" />
            New mapping
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Classification</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MAPPINGS.map((m, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {m.module}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{m.entity}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.field}</TableCell>
                  <TableCell>
                    <Badge variant={levelTone(m.level)} className="text-[10px]">
                      {m.level}
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
    </div>
  )
}
