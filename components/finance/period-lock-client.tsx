"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Lock, LockOpen, ShieldCheck, CalendarCheck, Plus } from "lucide-react"
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

type PeriodLock = {
  period: string
  status: "Locked" | "Open"
  note: string | null
  locked_by: number | null
  locked_at: string | null
  unlocked_by: number | null
  unlocked_at: string | null
}

type ApiData = { locks: PeriodLock[] }

const API = "/api/finance/period-lock"

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

function formatPeriod(period: string) {
  const d = new Date(`${period}-01T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return period
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
}

function formatWhen(value: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}

function currentPeriodKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export function PeriodLockClient() {
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

  const locks = data?.locks ?? []
  const lockedCount = useMemo(() => locks.filter((l) => l.status === "Locked").length, [locks])

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <Lock className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 162</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Accounting Period Lock</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Lock an accounting month to seal its books. Once locked, journal postings, invoice, payment and tax
              transactions dated in that month are rejected until an authorized user unlocks it.
            </p>
          </div>
        </div>
        <LockPeriodDialog busy={busy} onLock={run} />
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" />
            Locked periods
            <Badge variant="secondary">{lockedCount}</Badge>
          </CardTitle>
          <CardDescription>
            Locking is what enforces the freeze — the same check runs at every finance write path (journal, invoices,
            payments and tax), so a sealed trial balance can never move.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-muted-foreground">Loading periods…</p>}
          {error && <p className="text-sm text-destructive">Failed to load periods: {error.message}</p>}

          {!isLoading && !error && locks.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-card p-10 text-center">
              <Lock className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">No period locks yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Lock a month to prevent back-dated entries into a signed-off period.
              </p>
            </div>
          )}

          {locks.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Last change</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locks.map((lock) => (
                    <TableRow key={lock.period}>
                      <TableCell className="font-medium">{formatPeriod(lock.period)}</TableCell>
                      <TableCell>
                        {lock.status === "Locked" ? (
                          <Badge variant="secondary" className="gap-1 bg-destructive/10 text-destructive">
                            <Lock className="size-3" /> Locked
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          >
                            <CalendarCheck className="size-3" /> Open
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">{lock.note || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {lock.status === "Locked" ? formatWhen(lock.locked_at) : formatWhen(lock.unlocked_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {lock.status === "Locked" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              run(
                                { action: "unlock", period: lock.period },
                                `${formatPeriod(lock.period)} unlocked`,
                              )
                            }
                          >
                            <LockOpen className="size-4" /> Unlock
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              run({ action: "lock", period: lock.period }, `${formatPeriod(lock.period)} locked`)
                            }
                          >
                            <Lock className="size-4" /> Lock
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function LockPeriodDialog({
  busy,
  onLock,
}: {
  busy: boolean
  onLock: (body: Record<string, unknown>, success: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [period, setPeriod] = useState(currentPeriodKey())
  const [note, setNote] = useState("")

  const canSubmit = /^\d{4}-\d{2}$/.test(period) && !busy

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> Lock a period
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lock an accounting period</DialogTitle>
          <DialogDescription>
            Choose the month to seal. Any journal, invoice, payment or tax transaction dated in this month will be
            rejected until it is unlocked.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="lock-period">Period</Label>
            <Input id="lock-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="lock-note">Note (optional)</Label>
            <Textarea
              id="lock-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Month-end sign-off complete; books frozen for audit."
              rows={3}
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
              await onLock(
                { action: "lock", period, note: note.trim() || null },
                `${formatPeriod(period)} locked`,
              )
              setOpen(false)
              setNote("")
            }}
          >
            <Lock className="size-4" /> Lock period
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
