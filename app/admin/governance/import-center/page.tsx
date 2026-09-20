import { Upload, ArrowRight } from "lucide-react"
import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// SPEC 74 — Central Import Center (UI). A generic
// upload → map → validate → preview → import → result flow that sits on top
// of existing module-specific import endpoints, rather than replacing them.
const STEPS = ["Upload", "Map", "Validate", "Preview", "Import", "Result"]

const MODULES = [
  "Employees (HR)",
  "Chart of accounts (Finance)",
  "Journal entries (Finance)",
  "Leads (Sales)",
  "Companies (Sales)",
  "Contacts (Marketing)",
  "Products (Catalog)",
  "Knowledge base",
]

const HISTORY = [
  { id: "imp_1042", module: "Employees (HR)", file: "hr_employees_sep.csv", success: 118, failed: 3, skipped: 2, status: "Completed", when: "2026-09-18 09:12" },
  { id: "imp_1041", module: "Chart of accounts (Finance)", file: "coa_v3.xlsx", success: 86, failed: 0, skipped: 0, status: "Completed", when: "2026-09-16 14:40" },
  { id: "imp_1040", module: "Leads (Sales)", file: "leads_q3.csv", success: 0, failed: 0, skipped: 0, status: "Failed — invalid headers", when: "2026-09-14 11:03" },
]

export default function ImportCenterPage() {
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
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4 text-muted-foreground" />
            New import
          </CardTitle>
          <CardDescription>CSV, Excel, or JSON. Large imports run as a background job.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pt-4">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {STEPS.map((step, i) => (
              <div key={step} className="flex items-center gap-1.5">
                <span
                  className={
                    i === 0
                      ? "flex size-6 items-center justify-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground"
                      : "flex size-6 items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground"
                  }
                >
                  {i + 1}
                </span>
                <span className={i === 0 ? "font-medium" : "text-muted-foreground"}>{step}</span>
                {i < STEPS.length - 1 ? <ArrowRight className="size-3 text-muted-foreground" /> : null}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 sm:max-w-sm">
            <label className="text-xs font-medium text-muted-foreground">Target module</label>
            <Select defaultValue={MODULES[0]}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODULES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-10 text-center">
            <Upload className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">Drag a file here, or click to browse</p>
            <p className="text-xs text-muted-foreground">Supports .csv, .xlsx, .json — up to 25 MB</p>
            <Button size="sm" variant="outline" className="mt-1">
              Choose file
            </Button>
          </div>

          <div className="flex justify-end">
            <Button disabled>Continue to mapping</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Import history</CardTitle>
          <CardDescription>Row-level error reports are attached to each completed job.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Success</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Skipped</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HISTORY.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="text-sm">{h.module}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.file}</TableCell>
                  <TableCell className="text-xs">{h.success}</TableCell>
                  <TableCell className="text-xs">{h.failed}</TableCell>
                  <TableCell className="text-xs">{h.skipped}</TableCell>
                  <TableCell>
                    <Badge variant={h.status === "Completed" ? "secondary" : "destructive"} className="text-[10px]">
                      {h.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                    {h.when}
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
