"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import {
  CalendarRange,
  Plus,
  Lock,
  CheckCircle2,
  RotateCcw,
  Trash2,
  ShieldCheck,
  XCircle,
  Clock,
  CalendarCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

type PeriodStatus = "Open" | "Closed" | "Locked"

type ReopenRequest = {
  id: number
  period_id: number
  period_name?: string
  fiscal_year_name?: string
  reason: string | null
  status: "Pending" | "Approved" | "Rejected"
  requested_at: string
  decision_note: string | null
}

type FiscalPeriod = {
  id: number
  seq: number
  name: string
  period_key: string
  start_date: string
  end_date: string
  status: PeriodStatus
  reopen_request?: ReopenRequest | null
}

type FiscalYear = {
  id: number
  entity_id: number
  name: string
  start_date: string
  end_date: string
  status: "Open" | "Closed"
  periods: FiscalPeriod[]
}

type ApiData = { fiscalYears: FiscalYear[]; reopenRequests: ReopenRequest[] }

const API = "/api/finance/fiscal-year"

async function postAction(body: Record<string, unknown>) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || "Request failed")
  return json
}

function statusBadge(status: PeriodStatus) {
  if (status === "Locked") {
    return (
      <Badge variant="secondary" className="gap-1 bg-destructive/10 text-destructive">
        <Lock className="size-3" /> Locked
      </Badge>
    )
  }
  if (status === "Closed") {
    return (
      <Badge variant="secondary" className="gap-1 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <CheckCircle2 className="size-3" /> Closed
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
      <CalendarCheck className="size-3" /> Open
    </Badge>
  )
}

export function FiscalYearClient() {
  const { data, error, isLoading, mutate } = useSWR<ApiData>(API, fetcher)
  const [busy, setBusy] = useState(false)

  async function run(body: Record<string, unknown>, success: string) {
    setBusy(true)
    try {
      await postAction(body)
      toast.success(success)
      await mutate()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const years = data?.fiscalYears ?? []
  const pendingRequests = (data?.reopenRequests ?? []).filter((r) => r.status === "Pending")

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <CalendarRange className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 161</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Fiscal Year Engine</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Configure fiscal years per tenant and entity, break them into financial periods, and control period
              closing, locking, and approval-gated reopening.
            </p>
          </div>
        </div>
        <NewFiscalYearDialog busy={busy} onCreate={run} />
      </header>

      {pendingRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" />
              Reopening approvals
              <Badge variant="secondary">{pendingRequests.length}</Badge>
            </CardTitle>
            <CardDescription>
              Reopening a closed or locked period requires approval so a signed-off trial balance never moves silently.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendingRequests.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Clock className="size-3.5 text-muted-foreground" />
                    {r.fiscal_year_name} · {r.period_name}
                  </div>
                  <p className="text-sm text-muted-foreground">{r.reason || "No reason provided."}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => run({ action: "approve_reopen", requestId: r.id }, "Period reopened")}
                  >
                    <CheckCircle2 className="size-4" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => run({ action: "reject_reopen", requestId: r.id }, "Request rejected")}
                  >
                    <XCircle className="size-4" /> Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading fiscal years…</p>}
      {error && <p className="text-sm text-destructive">Failed to load fiscal years: {error.message}</p>}

      {!isLoading && years.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-10 text-center">
          <CalendarRange className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No fiscal years yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Create a fiscal year with its start and end dates — monthly financial periods are generated automatically.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-6">
        {years.map((year) => (
          <FiscalYearCard key={year.id} year={year} busy={busy} onAction={run} />
        ))}
      </div>
    </div>
  )
}

function FiscalYearCard({
  year,
  busy,
  onAction,
}: {
  year: FiscalYear
  busy: boolean
  onAction: (body: Record<string, unknown>, success: string) => Promise<void>
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-lg">
            {year.name}
            {year.status === "Closed" ? (
              <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                Closed
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                Open
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {year.start_date} → {year.end_date} · {year.periods.length} periods ·{" "}
            {year.entity_id ? `Entity #${year.entity_id}` : "All entities"}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          {year.status === "Open" && year.periods.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAction({ action: "close_year", yearId: year.id }, `${year.name} closed`)}
            >
              <CheckCircle2 className="size-4" /> Close year
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => onAction({ action: "delete_year", yearId: year.id }, `${year.name} deleted`)}
          >
            <Trash2 className="size-4" />
            <span className="sr-only">Delete {year.name}</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Range</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {year.periods.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{p.seq}</TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.start_date} → {p.end_date}
                  </TableCell>
                  <TableCell>{statusBadge(p.status)}</TableCell>
                  <TableCell className="text-right">
                    <PeriodActions period={p} busy={busy} onAction={onAction} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function PeriodActions({
  period,
  busy,
  onAction,
}: {
  period: FiscalPeriod
  busy: boolean
  onAction: (body: Record<string, unknown>, success: string) => Promise<void>
}) {
  if (period.reopen_request) {
    return (
      <Badge variant="outline" className="gap-1">
        <Clock className="size-3" /> Reopen pending
      </Badge>
    )
  }

  if (period.status === "Open") {
    return (
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onAction({ action: "close_period", periodId: period.id }, `${period.name} closed`)}
        >
          <CheckCircle2 className="size-4" /> Close
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onAction({ action: "lock_period", periodId: period.id }, `${period.name} locked`)}
        >
          <Lock className="size-4" /> Lock
        </Button>
      </div>
    )
  }

  // Closed or Locked → only path back is an approval-gated reopen request.
  return <ReopenRequestDialog period={period} busy={busy} onAction={onAction} />
}

function ReopenRequestDialog({
  period,
  busy,
  onAction,
}: {
  period: FiscalPeriod
  busy: boolean
  onAction: (body: Record<string, unknown>, success: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={busy}>
          <RotateCcw className="size-4" /> Request reopen
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request to reopen {period.name}</DialogTitle>
          <DialogDescription>
            This {period.status.toLowerCase()} period is sealed. Submit a reason for an approver to review — the period
            reopens only once approved.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reopen-reason">Reason</Label>
          <Textarea
            id="reopen-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Late vendor invoice must be booked in this month."
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || !reason.trim()}
            onClick={async () => {
              await onAction(
                { action: "request_reopen", periodId: period.id, reason: reason.trim() },
                "Reopen request submitted",
              )
              setOpen(false)
              setReason("")
            }}
          >
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewFiscalYearDialog({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (body: Record<string, unknown>, success: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [entityId, setEntityId] = useState("")

  function suggestFromStart(value: string) {
    setStartDate(value)
    // Suggest a 12-month fiscal year end and a name when the end is still blank.
    if (value && !endDate) {
      const d = new Date(`${value}T00:00:00Z`)
      if (!Number.isNaN(d.getTime())) {
        const end = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), 0))
        setEndDate(end.toISOString().slice(0, 10))
        if (!name) {
          const startY = d.getUTCFullYear()
          setName(`FY ${startY}-${String((startY + 1) % 100).padStart(2, "0")}`)
        }
      }
    }
  }

  const canSubmit = name.trim() && startDate && endDate && !busy

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> New fiscal year
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New fiscal year</DialogTitle>
          <DialogDescription>
            Monthly financial periods are generated automatically between the start and end dates.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="fy-name">Name</Label>
            <Input
              id="fy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="FY 2026-27"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="fy-start">Start date</Label>
              <Input id="fy-start" type="date" value={startDate} onChange={(e) => suggestFromStart(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="fy-end">End date</Label>
              <Input id="fy-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fy-entity">Entity ID (optional)</Label>
            <Input
              id="fy-entity"
              type="number"
              min={0}
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              placeholder="Leave blank for all entities"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={async () => {
              await onCreate(
                {
                  action: "create_year",
                  name: name.trim(),
                  startDate,
                  endDate,
                  entityId: entityId ? Number(entityId) : 0,
                },
                "Fiscal year created",
              )
              setOpen(false)
              setName("")
              setStartDate("")
              setEndDate("")
              setEntityId("")
            }}
          >
            Create fiscal year
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
