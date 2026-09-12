"use client"

import { useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertTriangle, Download, Plus, RefreshCw, Search, Upload } from "lucide-react"
import { describeCycle, type CycleType } from "@/lib/rotation-ui"
import { rotationState, stateVariant } from "./rotation-shared"
import { RotationWizardDialog } from "./rotation-wizard-dialog"
import { RotationDetailDialog } from "./rotation-detail-dialog"

type View = "all" | "running" | "scheduled" | "ended" | "conflicts"

const VALID_VIEWS: View[] = ["all", "running", "scheduled", "ended", "conflicts"]

export function ShiftRotationsClient() {
  const searchParams = useSearchParams()
  const initialView = searchParams.get("view") as View | null
  const [q, setQ] = useState("")
  const [cycleType, setCycleType] = useState("all")
  const [view, setView] = useState<View>(
    initialView && VALID_VIEWS.includes(initialView) ? initialView : "all",
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const isListView = view !== "conflicts"
  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (cycleType !== "all") params.set("cycle_type", cycleType)
  if (isListView && view !== "all") params.set("state", view)

  const { data, mutate, isLoading } = useSWR<any>(
    isListView ? `/api/hr/shift-rotations?${params.toString()}` : `/api/hr/shift-rotations`,
    fetcher,
  )
  const { data: ctx } = useSWR<any>("/api/hr/shift-rotations/context", fetcher)
  const { data: conflicts } = useSWR<any>("/api/hr/shift-rotations/conflicts", fetcher)

  const rotations: any[] = data?.rotations || []
  const summary = data?.summary || { running: 0, scheduled: 0, ended: 0, total: 0, assigned: 0 }
  const canManage = Boolean(data?.canManage ?? ctx?.canManage)

  const cards = [
    { label: "Running", value: summary.running, tone: "text-emerald-600" },
    { label: "Scheduled", value: summary.scheduled, tone: "text-blue-600" },
    { label: "Ended", value: summary.ended, tone: "text-muted-foreground" },
    { label: "Employees on rotation", value: summary.assigned, tone: "text-foreground" },
    { label: "Conflicts", value: conflicts?.total ?? 0, tone: conflicts?.total ? "text-destructive" : "text-foreground" },
    { label: "Total", value: summary.total, tone: "text-foreground" },
  ]

  async function onImportFile(file: File) {
    setImporting(true)
    try {
      const text = await file.text()
      const res = await fetch("/api/hr/shift-rotations/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Import failed.")
        return
      }
      toast.success(`Imported ${json.created ?? 0} rotation(s)${json.failed ? `, ${json.failed} failed` : ""}.`)
      mutate()
    } finally {
      setImporting(false)
      if (importRef.current) importRef.current.value = ""
    }
  }

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">HR / Workforce</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">Shift Rotations</h1>
          <p className="text-muted-foreground">
            Cyclic shift patterns that resolve an employee&apos;s daily shift when no explicit assignment applies.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="/api/hr/shift-rotations/export"
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="mr-2 h-4 w-4" />
            Export
          </a>
          {canManage && (
            <>
              <input
                ref={importRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onImportFile(f)
                }}
              />
              <Button
                variant="outline"
                onClick={() => importRef.current?.click()}
                disabled={importing}
                title="CSV columns: rotation_id, employee_code, start_date, end_date"
              >
                <Upload className="mr-2 h-4 w-4" />
                {importing ? "Importing…" : "Import members"}
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New rotation
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="running">Running</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="ended">Ended</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
        </TabsList>
      </Tabs>

      {isListView ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rotation id or name…" className="pl-8" />
            </div>
            <Select value={cycleType} onValueChange={(v) => setCycleType(v ?? "all")}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Cycle" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All cycles</SelectItem>
                <SelectItem value="Days">Days</SelectItem>
                <SelectItem value="Weeks">Weeks</SelectItem>
                <SelectItem value="Months">Months</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={() => mutate()} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rotation</TableHead>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                ) : rotations.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No rotations found.</TableCell></TableRow>
                ) : (
                  rotations.map((r) => (
                    <TableRow key={r.rotation_id} className="cursor-pointer" onClick={() => setDetailId(r.rotation_id)}>
                      <TableCell>
                        <div className="font-medium">{r.rotation_name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.rotation_id}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {describeCycle(r.cycle_type as CycleType, Number(r.cycle_length), [])}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {String(r.effective_from).slice(0, 10)} → {r.effective_until ? String(r.effective_until).slice(0, 10) : "Onward"}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="font-medium">{r.active_members ?? 0}</span>
                        <span className="text-muted-foreground"> / {r.total_members ?? 0}</span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">v{r.current_version_no}</TableCell>
                      <TableCell><Badge variant={stateVariant(rotationState(r))}>{rotationState(r)}</Badge></TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      ) : (
        <ConflictsPanel data={conflicts} onOpen={setDetailId} />
      )}

      <RotationWizardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        shifts={ctx?.shifts || []}
        onCreated={(id) => {
          mutate()
          setDetailId(id)
        }}
      />
      <RotationDetailDialog rotationId={detailId} onClose={() => setDetailId(null)} onChanged={mutate} />
    </main>
  )
}

function ConflictsPanel({ data, onOpen }: { data: any; onOpen: (id: string) => void }) {
  const overlapping: any[] = data?.overlapping || []
  const orphan: any[] = data?.orphanMembership || []
  const inactiveShift: any[] = data?.inactiveShift || []
  const empty = !data?.total

  if (empty) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
        No rotation conflicts detected. Membership windows, statuses and referenced shifts are all consistent.
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {overlapping.length > 0 && (
        <ConflictCard title={`Overlapping rotation memberships (${overlapping.length})`}>
          {overlapping.map((r) => (
            <li key={`${r.a_id}-${r.b_id}`} className="py-2 text-sm">
              <span className="font-medium">{r.employee_name}</span>{" "}
              <span className="text-xs text-muted-foreground">({r.employee_code})</span>:{" "}
              <button className="font-mono text-xs text-primary underline" onClick={() => onOpen(r.a_rotation)}>{r.a_rotation}</button> vs{" "}
              <button className="font-mono text-xs text-primary underline" onClick={() => onOpen(r.b_rotation)}>{r.b_rotation}</button>
            </li>
          ))}
        </ConflictCard>
      )}

      {orphan.length > 0 && (
        <ConflictCard title={`Active membership on an inactive rotation (${orphan.length})`}>
          {orphan.map((r) => (
            <li key={r.record_id} className="py-2 text-sm">
              <span className="font-medium">{r.employee_name}</span>{" "}
              <span className="text-xs text-muted-foreground">({r.employee_code})</span> ·{" "}
              <button className="font-mono text-xs text-primary underline" onClick={() => onOpen(r.rotation_id)}>{r.rotation_id}</button> {r.rotation_name}
            </li>
          ))}
        </ConflictCard>
      )}

      {inactiveShift.length > 0 && (
        <ConflictCard title={`Pattern references an inactive shift (${inactiveShift.length})`}>
          {inactiveShift.map((r, i) => (
            <li key={`${r.rotation_id}-${i}`} className="py-2 text-sm">
              <button className="font-mono text-xs text-primary underline" onClick={() => onOpen(r.rotation_id)}>{r.rotation_id}</button>{" "}
              {r.rotation_name} · {r.shift_name}
            </li>
          ))}
        </ConflictCard>
      )}
    </div>
  )
}

function ConflictCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <ul className="divide-y px-5 py-2">{children}</ul>
    </div>
  )
}
