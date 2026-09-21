"use client"
import { useEffect, useState } from "react"
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  Plug,
  Plug2,
  RotateCcw,
  Send,
  Users,
} from "lucide-react"
import { EVENT_CATALOG, type EventType } from "@/lib/events/model"
import { AutomationTabs } from "./automation-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

const control =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 appearance-none"

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed" || status === "blocked") return "destructive"
  if (status === "delivered" || status === "sent") return "default"
  if (status === "pending" || status === "queued") return "secondary"
  return "outline"
}

export function BusinessEventMonitor() {
  const [data, setData] = useState<any>({ events: [], subscriptions: [], deliveries: [], history: [] })
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [inventoryOpen, setInventoryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [name, setName] = useState("")
  const [eventType, setEventType] = useState<EventType>("deal.won")
  const [handler, setHandler] = useState("notice")
  const [target, setTarget] = useState("")

  async function load() {
    const response = await fetch("/api/admin/event-bus")
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    setData(body)
  }
  useEffect(() => {
    load().catch((e) => setError(e.message))
    const timer = setInterval(() => load().catch((e) => setError(e.message)), 15000)
    return () => clearInterval(timer)
  }, [])
  async function send(body: unknown) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/admin/event-bus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  const activeEvents = Object.entries(EVENT_CATALOG).filter(([, v]) => v.publisher === "active")

  return (
    <main className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Activity className="size-5" />
        </span>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Business event bus</h1>
          <p className="text-sm text-muted-foreground">
            Committed business changes flow into saved events, which fan out to independent subscriber deliveries.
            Latest 100 events and 200 deliveries are shown; existing records are not backfilled.
          </p>
        </div>
      </div>

      <AutomationTabs />

      {error && (
        <Alert variant="destructive" role="status">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <button
            type="button"
            className="flex w-full items-center justify-between text-left"
            onClick={() => setInventoryOpen((v) => !v)}
            aria-expanded={inventoryOpen}
          >
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Plug2 className="size-4 text-muted-foreground" /> Event inventory
              </CardTitle>
              <CardDescription>Which business events currently publish, and which are still planned.</CardDescription>
            </div>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", inventoryOpen && "rotate-180")} />
          </button>
        </CardHeader>
        {inventoryOpen && (
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {Object.entries(EVENT_CATALOG).map(([type, info]) => (
              <div key={type} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5 text-sm">
                <div className="flex items-center gap-2 truncate">
                  <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{type}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">· {info.module}</span>
                </div>
                <Badge variant={info.publisher === "active" ? "default" : "outline"} className="shrink-0 gap-1">
                  <Circle className={cn("size-1.5 fill-current", info.publisher !== "active" && "opacity-50")} />
                  {info.publisher === "active" ? "Connected" : "Not connected"}
                </Badge>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" /> Add subscriber
          </CardTitle>
          <CardDescription>Route an active business event to an in-app notification or a Sales workflow.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Notify sales manager" />
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Event</span>
            <select
              className={control}
              value={eventType}
              onChange={(e) => {
                setEventType(e.target.value as EventType)
                setHandler("notice")
                setTarget("")
              }}
            >
              {activeEvents.map(([type]) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Subscriber action</span>
            <select
              className={control}
              value={handler}
              onChange={(e) => {
                setHandler(e.target.value)
                setTarget("")
              }}
            >
              <option value="notice">In-app notification</option>
              {eventType === "deal.won" && <option value="workflow">Start Sales workflow</option>}
            </select>
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">
              {handler === "notice" ? "Recipient user ID" : "Existing manual Sales workflow ID"}
            </span>
            <Input type="number" min="1" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Label>
          <p className="col-span-full text-xs text-muted-foreground">
            Workflow definitions are snapshotted when subscribing. Disabling a subscriber stops future events only;
            queued deliveries continue. For workflow edits, disable the old subscriber and create a new one.
          </p>
        </CardContent>
        <CardFooter>
          <Button
            disabled={busy || !name.trim() || !target}
            onClick={() =>
              send({
                operation: "subscribe",
                subscription: {
                  name,
                  eventType,
                  handler,
                  ...(handler === "notice" ? { userId: Number(target) } : { workflowId: Number(target) }),
                },
              })
            }
          >
            Add subscriber
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Subscribers</CardTitle>
          <CardDescription>{data.subscriptions.length} configured</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.subscriptions.length === 0 && <p className="text-sm text-muted-foreground">No subscribers yet.</p>}
          {data.subscriptions.map((s: any) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-2.5">
              <span className="text-sm font-medium">#{s.id} {s.name}</span>
              <Badge variant="outline">{s.event_type}</Badge>
              <Badge variant={s.enabled ? "default" : "secondary"}>{s.enabled ? "Enabled" : "Disabled"}</Badge>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={busy}
                onClick={() => send({ operation: "toggle", id: Number(s.id), enabled: !s.enabled })}
              >
                {s.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Business events</CardTitle>
          <CardDescription>Most recent committed events across the tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Deliveries</TableHead>
                  <TableHead>Pending</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No events yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.events.map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">#{e.id}</TableCell>
                    <TableCell><Badge variant="outline">{e.event_type}</Badge></TableCell>
                    <TableCell>#{e.entity_id}</TableCell>
                    <TableCell>{e.subscribers}</TableCell>
                    <TableCell>{e.pending || 0}</TableCell>
                    <TableCell className={e.failed ? "text-destructive" : undefined}>{e.failed || 0}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.created_at}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" /> Subscriber deliveries
          </CardTitle>
          <CardDescription>Independent per-subscriber delivery attempts. Failed deliveries can be retried once.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Subscriber</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.deliveries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No deliveries yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.deliveries.map((d: any) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">#{d.id}</TableCell>
                    <TableCell>#{d.event_id}</TableCell>
                    <TableCell>#{d.subscriber_id}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(d.status)}>
                        {d.status}
                        {d.error_code ? `: ${d.error_code}` : ""}
                      </Badge>
                    </TableCell>
                    <TableCell>{d.attempts}</TableCell>
                    <TableCell>{d.result_id ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {d.status === "failed" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => send({ operation: "retry", id: Number(d.id), attempt: Number(d.attempts) })}
                        >
                          <RotateCcw className="size-3.5" /> Retry
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <button
            type="button"
            className="flex w-full items-center justify-between text-left"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
          >
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-muted-foreground" /> Delivery history
              </CardTitle>
              <CardDescription>Full audit trail of delivery attempts.</CardDescription>
            </div>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", historyOpen && "rotate-180")} />
          </button>
        </CardHeader>
        {historyOpen && (
          <CardContent className="space-y-1.5">
            {data.history.length === 0 && <p className="text-sm text-muted-foreground">No history yet.</p>}
            {data.history.map((h: any, i: number) => (
              <p key={i} className="text-sm text-muted-foreground">
                Delivery #{h.delivery_id} · {h.action} · Attempt {h.attempt} · {h.created_at}
              </p>
            ))}
          </CardContent>
        )}
      </Card>
    </main>
  )
}
