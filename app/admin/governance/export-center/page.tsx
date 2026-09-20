import { Download, Plus } from "lucide-react"
import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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

// SPEC 73 — Central Export Center (UI). A reusable export-job layer that
// wraps existing module-specific export buttons instead of replacing them —
// full-tenant and scheduled exports go through background jobs with
// permission-checked, expiring download links.
const MODULES = ["Employees (HR)", "Invoices (Finance)", "Leads (Sales)", "Customers (CRM)", "Full tenant export"]
const FORMATS = ["CSV", "Excel", "JSON", "PDF"]

const JOBS = [
  { id: "exp_5521", module: "Employees (HR)", format: "Excel", requestedBy: "priya.sharma@acme.com", status: "Completed", progress: 100, created: "2026-09-19 08:02", expires: "2026-09-26", file: "employees_2026-09-19.xlsx" },
  { id: "exp_5520", module: "Full tenant export", format: "JSON", requestedBy: "rahul.verma@acme.com", status: "Running", progress: 64, created: "2026-09-19 07:40", expires: "—", file: null },
  { id: "exp_5519", module: "Invoices (Finance)", format: "CSV", requestedBy: "anita.rao@acme.com", status: "Expired", progress: 100, created: "2026-08-30 11:15", expires: "2026-09-06", file: null },
]

export default function ExportCenterPage() {
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
            <Download className="size-4 text-muted-foreground" />
            New export
          </CardTitle>
          <CardDescription>Module, selected records, or a full tenant export. Large jobs run in the background.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="grid gap-3 sm:grid-cols-2 sm:max-w-lg">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Module / scope</label>
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
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Format</label>
              <Select defaultValue={FORMATS[0]}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="gap-1.5">
              <Plus className="size-3.5" />
              Start export
            </Button>
            <Button size="sm" variant="outline">
              Schedule recurring export
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Export jobs</CardTitle>
          <CardDescription>Download links expire and are permission-checked at access time.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">File</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {JOBS.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="text-sm">{j.module}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.format}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.requestedBy}</TableCell>
                  <TableCell className="w-32">
                    <Progress value={j.progress} className="h-1.5" />
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        j.status === "Completed" ? "secondary" : j.status === "Running" ? "outline" : "destructive"
                      }
                      className="text-[10px]"
                    >
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.expires}</TableCell>
                  <TableCell className="text-right">
                    {j.file ? (
                      <Button variant="ghost" size="sm" className="gap-1">
                        <Download className="size-3.5" />
                        {j.file}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
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
