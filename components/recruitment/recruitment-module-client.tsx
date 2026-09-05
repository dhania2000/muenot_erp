"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Plus, FilterX, Pencil, Eye, Trash2,
  ClipboardList, Users, UserCheck, UserPlus, UserX, FileText, FileCheck,
  ListChecks, Clock, Gauge, CalendarClock, ClipboardCheck, Network, Coins,
  Settings2, ToggleRight, ToggleLeft, Layers,
} from "lucide-react"
import { inr, inr0 } from "@/lib/finance-calc"
import { RECRUITMENT_MODULE_CONFIGS } from "@/lib/recruitment-module-configs"
import { RecruitmentModuleDialog } from "@/components/recruitment/recruitment-module-dialog"
import type { BadgeVariant, ModuleConfig, TableColumn } from "@/lib/finance-schema"

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  ClipboardList, Users, UserCheck, UserPlus, UserX, FileText, FileCheck,
  ListChecks, Clock, Gauge, CalendarClock, ClipboardCheck, Network, Coins,
  Settings2, ToggleRight, ToggleLeft, Layers,
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

type Row = Record<string, any>

function cellValue(col: TableColumn, row: Row) {
  const raw = row[col.key]
  if (col.money) return inr(raw)
  if (raw === null || raw === undefined || raw === "") return "—"
  return String(raw)
}

export function RecruitmentModuleClient({ moduleKey }: { moduleKey: string }) {
  const cfg = RECRUITMENT_MODULE_CONFIGS[moduleKey]
  if (!cfg) return <div className="p-6 text-sm text-muted-foreground">Unknown recruitment module.</div>
  return <ModuleView cfg={cfg} />
}

function ModuleView({ cfg }: { cfg: ModuleConfig }) {
  const emptyFilters = useMemo(
    () => ({ search: "", status: "", month: "", date_from: "", date_to: "" }),
    [],
  )
  const [filters, setFilters] = useState(emptyFilters)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [viewing, setViewing] = useState<Row | null>(null)

  const queryKey = useMemo(() => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
    return `/api/recruitment/module/${cfg.key}?${params.toString()}`
  }, [cfg.key, filters])

  const { data, mutate } = useSWR<{ rows: Row[]; summary: any; filterOptions: any }>(queryKey, fetcher)

  const rows = data?.rows ?? []
  const summary = data?.summary ?? {}
  const statuses: string[] = data?.filterOptions?.statuses ?? []
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const hasDate = !!cfg.dateColumn
  const hasStatus = !!cfg.statusColumn

  function openNew() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(row: Row) {
    setEditing(row)
    setDialogOpen(true)
  }
  async function remove(row: Row) {
    if (!confirm(`Delete ${row[cfg.idColumn]}? This cannot be undone.`)) return
    await fetch(`/api/recruitment/module/${cfg.key}?id=${row.id}`, { method: "DELETE" })
    mutate()
  }

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{cfg.subtitle}</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">{cfg.label}</h1>
        </div>
        <Button onClick={openNew}>
          <Plus data-icon="inline-start" />
          {cfg.addLabel}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cfg.kpis.map((k) => {
          const Icon = (k.icon && ICONS[k.icon]) || FileText
          const value = summary[k.key]
          return (
            <Card key={k.label}>
              <CardContent className="flex flex-col gap-2 pt-6">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <span className="text-xl font-semibold tracking-tight">
                  {k.money ? inr0(value) : (value ?? 0)}
                </span>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            placeholder="Search..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="lg:col-span-2"
          />
          {hasStatus && (
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Status"
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="">All statuses</option>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {hasDate && (
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Month"
              value={filters.month}
              onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}
            >
              <option value="">All months</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          )}
          {hasDate && (
            <div className="flex items-center gap-2 lg:col-span-2">
              <Input type="date" aria-label="From date" value={filters.date_from} onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value }))} />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" aria-label="To date" value={filters.date_to} onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value }))} />
            </div>
          )}
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setFilters(emptyFilters)}>
              <FilterX data-icon="inline-start" />
              Clear filters ({activeFilterCount})
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">{cfg.label}</span>
            <Badge variant="secondary">{rows.length} records</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {cfg.tableColumns.map((col) => (
                    <th key={col.key} className={`p-2 font-medium ${col.align === "right" ? "text-right" : ""}`}>
                      {col.label}
                    </th>
                  ))}
                  <th className="p-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={cfg.tableColumns.length + 1} className="p-6 text-center text-muted-foreground">
                      No records match the current filters.
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id} className="border-b hover:bg-muted/40">
                    {cfg.tableColumns.map((col) => (
                      <td key={col.key} className={`p-2 ${col.align === "right" ? "text-right" : ""} ${col.mono ? "font-mono text-xs" : ""}`}>
                        <TableCellContent col={col} row={row} />
                      </td>
                    ))}
                    <td className="p-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label="View" onClick={() => setViewing(row)}>
                          <Eye className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(row)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => remove(row)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <RecruitmentModuleDialog
        cfg={cfg}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        record={editing}
        onSaved={() => {
          setDialogOpen(false)
          mutate()
        }}
      />

      <DetailDialog cfg={cfg} row={viewing} onClose={() => setViewing(null)} />
    </main>
  )
}

function TableCellContent({ col, row }: { col: TableColumn; row: Row }) {
  if (col.badge) {
    const value = row[col.key]
    const variant: BadgeVariant = (value && col.badge[value]) || "outline"
    return value ? <Badge variant={variant}>{value}</Badge> : <span className="text-muted-foreground">—</span>
  }
  const main = cellValue(col, row)
  const sub = col.sub ? row[col.sub] : null
  if (sub) {
    return (
      <div>
        <div className="font-medium">{main}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
    )
  }
  return <>{main}</>
}

function DetailDialog({ cfg, row, onClose }: { cfg: ModuleConfig; row: Row | null; onClose: () => void }) {
  const sections = useMemo(() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const f of cfg.fields) {
      if (!seen.has(f.section)) {
        seen.add(f.section)
        order.push(f.section)
      }
    }
    return order
  }, [cfg])

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        {row && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{row[cfg.idColumn]}</DialogTitle>
              <DialogDescription>
                {cfg.label} · created by {row.created_by_name || "—"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 py-2 text-sm">
              {sections.map((section) => {
                const fields = cfg.fields.filter((f) => f.section === section)
                return (
                  <div key={section}>
                    <h3 className="mb-2 text-sm font-semibold">{section}</h3>
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                      {fields.map((f) => {
                        let value = row[f.key]
                        if (f.type === "checkbox") value = value ? "Yes" : "No"
                        else if (f.money) value = inr(value)
                        return (
                          <div key={f.key} className="flex justify-between gap-4 border-b border-dashed py-1">
                            <dt className="text-muted-foreground">{f.label}</dt>
                            <dd className="text-right font-medium">
                              {value === null || value === undefined || value === "" ? "—" : String(value)}
                            </dd>
                          </div>
                        )
                      })}
                    </dl>
                  </div>
                )
              })}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Record history</h3>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  <div className="flex justify-between gap-4 border-b border-dashed py-1">
                    <dt className="text-muted-foreground">Created at</dt>
                    <dd className="text-right font-medium">{row.created_at || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-dashed py-1">
                    <dt className="text-muted-foreground">Last updated</dt>
                    <dd className="text-right font-medium">{row.updated_at || "—"}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
