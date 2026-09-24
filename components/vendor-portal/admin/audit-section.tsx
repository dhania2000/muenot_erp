"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { ScrollText, Download, ShieldAlert, CheckCircle2, XCircle, Activity } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SectionHeader, SearchInput, FilterChips, StatusBadge, EmptyState, AdminTable, KpiTile, type Column } from "./shared"
import { AUDIT_ENTRIES, type AuditEntry } from "./mock-data"

type ResultFilter = "all" | "success" | "failure"

const COLUMNS: Column[] = [
  { key: "timestamp", header: "Timestamp" },
  { key: "actor", header: "Actor" },
  { key: "vendor", header: "Vendor" },
  { key: "action", header: "Action" },
  { key: "resource", header: "Resource" },
  { key: "change", header: "Change" },
  { key: "ip", header: "IP" },
  { key: "result", header: "Result" },
]

export function AuditSection() {
  const [search, setSearch] = useState("")
  const [result, setResult] = useState<ResultFilter>("all")
  const [action, setAction] = useState("all")

  const actions = useMemo(() => Array.from(new Set(AUDIT_ENTRIES.map((a) => a.action))), [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return AUDIT_ENTRIES.filter((a) => {
      if (q && !`${a.actor} ${a.vendor} ${a.user} ${a.action} ${a.resource}`.toLowerCase().includes(q)) return false
      if (result !== "all" && a.result !== result) return false
      if (action !== "all" && a.action !== action) return false
      return true
    })
  }, [search, result, action])

  const total = AUDIT_ENTRIES.length
  const failures = AUDIT_ENTRIES.filter((a) => a.result === "failure").length
  const logins = AUDIT_ENTRIES.filter((a) => a.action.toLowerCase().includes("login")).length
  const sensitive = AUDIT_ENTRIES.filter(
    (a) => a.action.toLowerCase().includes("bank") || a.action.toLowerCase().includes("permission"),
  ).length

  const resultFilters: { value: ResultFilter; label: string; count?: number }[] = [
    { value: "all", label: "All", count: total },
    { value: "success", label: "Success", count: total - failures },
    { value: "failure", label: "Failure", count: failures },
  ]

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Activity & Audit Logs"
        description="Immutable trail of every action taken in the vendor portal. Filter, investigate and export for compliance reviews."
        icon={ScrollText}
        actions={
          <Button variant="outline" size="sm" onClick={() => toast.success("Audit log exported (CSV)")}>
            <Download className="size-4" /> Export
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Total events" value={String(total)} icon={Activity} />
        <KpiTile label="Logins" value={String(logins)} icon={CheckCircle2} />
        <KpiTile label="Sensitive changes" value={String(sensitive)} icon={ShieldAlert} />
        <KpiTile label="Failures" value={String(failures)} icon={XCircle} />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search actor, vendor, action…" />
        <div className="flex flex-wrap items-center gap-3">
          <Select value={action} onValueChange={(v) => setAction(v as string)}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {actions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FilterChips options={resultFilters} value={result} onChange={setResult} />
        </div>
      </div>

      <AdminTable
        columns={COLUMNS}
        rows={filtered}
        empty={<EmptyState icon={ScrollText} title="No audit entries" description="No events match your filters." />}
        render={(a: AuditEntry, key) => {
          switch (key) {
            case "timestamp":
              return <span className="font-mono text-xs text-muted-foreground">{a.timestamp}</span>
            case "actor":
              return (
                <div className="grid">
                  <span className="font-medium">{a.actor}</span>
                  <span className="text-xs text-muted-foreground">{a.user}</span>
                </div>
              )
            case "vendor":
              return <span className="text-muted-foreground">{a.vendor}</span>
            case "action":
              return a.action
            case "resource":
              return <span className="font-mono text-xs text-muted-foreground">{a.resource}</span>
            case "change":
              return a.oldValue === "—" && a.newValue === "—" ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="text-xs">
                  <span className="text-muted-foreground line-through">{a.oldValue}</span>
                  {" → "}
                  <span className="font-medium">{a.newValue}</span>
                </span>
              )
            case "ip":
              return <span className="font-mono text-xs text-muted-foreground">{a.ip}</span>
            case "result":
              return (
                <StatusBadge
                  tone={a.result === "success" ? "success" : "danger"}
                  label={a.result}
                />
              )
            default:
              return null
          }
        }}
      />

      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {total} events · Logs are retained for 7 years and cannot be edited or deleted.
      </p>
    </div>
  )
}
