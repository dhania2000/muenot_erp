"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Pill, StatCard } from "./engine-shared"

type EventStatus = "processed" | "duplicate" | "ignored" | "failed" | "processing"

type WebhookEvent = {
  id: number
  gateway: string
  event_id: string
  event_type: string
  status: EventStatus
  effect: string | null
  attempts: number
  signature_ok: boolean
  invoice_id: number | null
  payment_id: number | null
  last_error: string | null
  reason: string | null
  received_at: string | null
  updated_at: string | null
  created_at: string
}

type Stats = {
  total: number
  processed: number
  duplicate: number
  ignored: number
  failed: number
  processing: number
  retried: number
}

const KEY = "/api/billing/webhooks/events"

const STATUS_TONE: Record<EventStatus, string> = {
  processed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  duplicate: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  ignored: "bg-muted text-muted-foreground",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  processing: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
}

const FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Failed", value: "failed" },
  { label: "Processed", value: "processed" },
  { label: "Ignored", value: "ignored" },
  { label: "Duplicate", value: "duplicate" },
]

export function WebhookMonitor() {
  const [filter, setFilter] = useState("")
  const [detail, setDetail] = useState<WebhookEvent | null>(null)
  const [replaying, setReplaying] = useState<number | null>(null)
  const url = filter ? `${KEY}?status=${filter}` : KEY
  const { data, isLoading, mutate } = useSWR<{ events: WebhookEvent[]; stats: Stats }>(url, fetcher, {
    refreshInterval: 15000,
  })

  const events = data?.events ?? []
  const stats = data?.stats

  async function replay(id: number) {
    setReplaying(id)
    try {
      const res = await fetch(`${KEY}/${id}/replay`, { method: "POST" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Replay failed")
      const r = json.result
      toast.success(
        r.status === "processed"
          ? `Replayed — ${labelEffect(r.effect)}`
          : `Replayed — ${r.status}${r.reason ? `: ${r.reason}` : ""}`,
      )
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setReplaying(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Payment Webhooks</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every verified gateway webhook is stored, deduplicated and applied exactly once. Failed events are retried
            on redelivery and can be replayed manually once the cause is fixed.
          </p>
        </div>
        <Button variant="outline" className="shrink-0 bg-transparent" onClick={() => mutate()}>
          Refresh
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total events" value={String(stats?.total ?? 0)} />
        <StatCard label="Processed" value={String(stats?.processed ?? 0)} hint={`${stats?.duplicate ?? 0} duplicates`} />
        <StatCard
          label="Failed"
          value={String(stats?.failed ?? 0)}
          hint={(stats?.processing ?? 0) > 0 ? `${stats?.processing} in progress` : "Need attention"}
        />
        <StatCard label="Retried" value={String(stats?.retried ?? 0)} hint="Delivered more than once" />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-medium">Event ledger</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <Button
                key={f.value || "all"}
                size="sm"
                variant={filter === f.value ? "default" : "outline"}
                className={filter === f.value ? "" : "bg-transparent"}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading webhook events…</div>
          ) : events.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No webhook events{filter ? ` with status “${filter}”` : ""} yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Gateway</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Effect</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id} className="cursor-pointer" onClick={() => setDetail(e)}>
                      <TableCell className="max-w-[180px] truncate font-mono text-xs" title={e.event_id}>
                        {e.event_id}
                      </TableCell>
                      <TableCell className="capitalize">{e.gateway}</TableCell>
                      <TableCell className="font-mono text-xs">{e.event_type}</TableCell>
                      <TableCell>
                        <Pill tone={STATUS_TONE[e.status] ?? STATUS_TONE.ignored}>{e.status}</Pill>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{labelEffect(e.effect)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {e.attempts > 1 ? (
                          <span className="font-medium text-amber-600 dark:text-amber-400">{e.attempts}</span>
                        ) : (
                          e.attempts
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(e.received_at ?? e.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="bg-transparent"
                          disabled={replaying === e.id}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            replay(e.id)
                          }}
                        >
                          {replaying === e.id ? "Replaying…" : "Replay"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <EventDetailDialog event={detail} onOpenChange={(v) => !v && setDetail(null)} />
    </div>
  )
}

function EventDetailDialog({
  event,
  onOpenChange,
}: {
  event: WebhookEvent | null
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Dialog open={!!event} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Webhook event</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{event?.event_id}</DialogDescription>
        </DialogHeader>
        {event ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Field label="Gateway" value={event.gateway} />
            <Field label="Type" value={event.event_type} mono />
            <Field label="Status" value={event.status} />
            <Field label="Effect" value={labelEffect(event.effect)} />
            <Field label="Attempts" value={String(event.attempts)} />
            <Field label="Signature" value={event.signature_ok ? "Verified" : "Unverified"} />
            <Field label="Invoice" value={event.invoice_id ? `#${event.invoice_id}` : "—"} />
            <Field label="Payment" value={event.payment_id ? `#${event.payment_id}` : "—"} />
            <Field label="Received" value={formatTime(event.received_at ?? event.created_at)} />
            <Field label="Updated" value={formatTime(event.updated_at)} />
            {event.reason ? <Field label="Reason" value={event.reason} full /> : null}
            {event.last_error ? <Field label="Last error" value={event.last_error} full tone="text-red-600 dark:text-red-400" /> : null}
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  value,
  mono,
  full,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  full?: boolean
  tone?: string
}) {
  return (
    <div className={full ? "col-span-2 space-y-1" : "space-y-1"}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`${mono ? "font-mono text-xs" : "text-sm"} ${tone ?? "text-foreground"} break-words`}>{value}</dd>
    </div>
  )
}

function labelEffect(effect: string | null | undefined): string {
  if (!effect || effect === "none") return "—"
  return effect.replace(/_/g, " ")
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
