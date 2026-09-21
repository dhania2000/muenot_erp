"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ShieldCheck, Search, Download, ChevronRight } from "lucide-react"
import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

// SPEC 67 — Central Tenant Audit Log (UI). Aggregates the tenant-scoped
// security-sensitive actions already recorded by module-specific audit
// trails into one searchable, filterable view.
const AUDIT_EVENTS = [
  {
    id: "evt_9f21",
    timestamp: "2026-09-19 14:32:08",
    user: "priya.sharma@acme.com",
    module: "HR",
    entity: "Employee",
    record: "EMP-1042",
    action: "record.updated",
    result: "success",
    ip: "103.21.58.10",
  },
  {
    id: "evt_9f20",
    timestamp: "2026-09-19 13:58:41",
    user: "system",
    module: "Finance",
    entity: "Invoice",
    record: "INV-2026-0871",
    action: "invoice.created",
    result: "success",
    ip: "internal",
  },
  {
    id: "evt_9f19",
    timestamp: "2026-09-19 12:10:02",
    user: "rahul.verma@acme.com",
    module: "Security",
    entity: "ApiKey",
    record: "key_a91c",
    action: "api_key.revoked",
    result: "success",
    ip: "49.207.11.88",
  },
  {
    id: "evt_9f18",
    timestamp: "2026-09-19 11:47:19",
    user: "unknown",
    module: "Security",
    entity: "Session",
    record: "-",
    action: "login.failed",
    result: "failure",
    ip: "185.220.101.4",
  },
  {
    id: "evt_9f17",
    timestamp: "2026-09-19 10:05:55",
    user: "anita.rao@acme.com",
    module: "CRM",
    entity: "Deal",
    record: "DEAL-3390",
    action: "deal.stage_changed",
    result: "success",
    ip: "103.21.58.44",
  },
]

const MODULE_OPTIONS = ["All modules", "HR", "Finance", "CRM", "Security", "Projects", "Storage"]
const RESULT_OPTIONS = ["All results", "success", "failure"]

export default function GovernanceAuditLogPage() {
  const [query, setQuery] = useState("")
  const [module, setModule] = useState("All modules")
  const [result, setResult] = useState("All results")
  const [fromDate, setFromDate] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return AUDIT_EVENTS.filter((e) => {
      if (module !== "All modules" && e.module !== module) return false
      if (result !== "All results" && e.result !== result) return false
      if (fromDate && e.timestamp.slice(0, 10) < fromDate) return false
      if (!q) return true
      return (
        e.user.toLowerCase().includes(q) ||
        e.record.toLowerCase().includes(q) ||
        e.action.toLowerCase().includes(q) ||
        e.entity.toLowerCase().includes(q)
      )
    })
  }, [query, module, result, fromDate])

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
              <ShieldCheck className="size-4 text-muted-foreground" />
              Tenant audit log
            </CardTitle>
            <CardDescription>Search across every module&apos;s security-sensitive events.</CardDescription>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadCsv(filtered)}>
            <Download className="size-3.5" />
            Export
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                placeholder="Search by user, record ID, action..."
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODULE_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={result} onValueChange={setResult}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESULT_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              className="w-full sm:w-40"
              aria-label="From date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Module</TableHead>
                  <TableHead>Entity / record</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead className="text-right">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No events match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {e.timestamp}
                      </TableCell>
                      <TableCell className="text-sm">{e.user}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {e.module}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.entity} · {e.record}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.action}</TableCell>
                      <TableCell>
                        <Badge
                          variant={e.result === "success" ? "secondary" : "destructive"}
                          className="text-[10px]"
                        >
                          {e.result}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.ip}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="size-7" aria-label="View detail">
                          <ChevronRight className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {filtered.length} of {AUDIT_EVENTS.length} events
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Retention policy for this log is managed under{" "}
        <Link href="/admin/governance/retention" className="underline">
          Retention
        </Link>
        .
      </p>
    </div>
  )
}

function downloadCsv(events: typeof AUDIT_EVENTS) {
  const header = ["timestamp", "user", "module", "entity", "record", "action", "result", "ip"]
  const rows = events.map((e) => [e.timestamp, e.user, e.module, e.entity, e.record, e.action, e.result, e.ip])
  const csv = [header, ...rows].map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = "audit-log.csv"
  link.click()
  URL.revokeObjectURL(url)
}
