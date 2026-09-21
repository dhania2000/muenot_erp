"use client"
import { useEffect, useState } from "react"
import { AlertCircle, Bell, ChevronDown, RotateCcw, Send, Sparkles } from "lucide-react"
import { CHANNELS } from "@/lib/notification-engine/model"
import { NotificationPreferences } from "@/components/notification-preferences"
import { AutomationTabs } from "./automation-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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

export function NotificationEnginePanel() {
  const [data, setData] = useState<any>({ templates: [], deliveries: [], history: [] })
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [template, setTemplate] = useState("")
  const [user, setUser] = useState("")
  const [channel, setChannel] = useState("in_app")
  const [priority, setPriority] = useState(5)
  const [at, setAt] = useState("")
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [key, setKey] = useState("")

  async function load() {
    const r = await fetch("/api/admin/notification-engine")
    const b = await r.json()
    if (!r.ok) throw new Error(b.error)
    setData(b)
  }
  useEffect(() => {
    load().catch((e) => setMessage(e.message))
    const t = setInterval(() => load().catch(() => {}), 15000)
    return () => clearInterval(t)
  }, [])
  async function send(b: unknown) {
    setBusy(true)
    try {
      const r = await fetch("/api/admin/notification-engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error)
      setMessage("Saved" + (v.id ? ` #${v.id}` : ""))
      await load()
      return true
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed")
      return false
    } finally {
      setBusy(false)
    }
  }
  const chosen = data.templates.find((t: any) => String(t.id) === template)
  const names = [
    ...new Set<string>(
      Array.from(((chosen?.title ?? "") + " " + (chosen?.body ?? "")).matchAll(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g), (m: any) => m[1]),
    ),
  ]
  function change() {
    setKey("")
  }
  const isError = message && !/^saved/i.test(message)

  return (
    <main className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Bell className="size-5" />
        </span>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Notification engine</h1>
          <p className="text-sm text-muted-foreground">
            Create reusable templates, then send or schedule notifications to a recipient over any channel. Delivery
            is tracked independently and failed sends can be retried.
          </p>
        </div>
      </div>

      <AutomationTabs />

      {message && (
        <Alert variant={isError ? "destructive" : "default"} role="status">
          <AlertCircle />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" /> Create template
          </CardTitle>
          <CardDescription>
            Plain text with variables such as <code className="rounded bg-muted px-1 py-0.5">{"{{name}}"}</code>.
            Saved templates are immutable — create a new one for changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Label>
          <Label className="col-span-full block space-y-1.5">
            <span className="text-xs text-muted-foreground">Body</span>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} />
          </Label>
        </CardContent>
        <CardFooter>
          <Button disabled={busy || !name.trim() || !title.trim()} onClick={() => send({ operation: "template", name, title, body })}>
            Save template
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" /> Send / schedule notification
          </CardTitle>
          <CardDescription>Choose a template and recipient. Leave the schedule blank to send immediately.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Template</span>
            <select
              className={control}
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value)
                setVariables({})
                change()
              }}
            >
              <option value="">Select…</option>
              {data.templates.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Recipient user ID</span>
            <Input
              type="number"
              min="1"
              value={user}
              onChange={(e) => {
                setUser(e.target.value)
                change()
              }}
            />
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Channel</span>
            <select
              className={control}
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value)
                change()
              }}
            >
              {CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Label>
          <Label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Priority</span>
            <select
              className={control}
              value={priority}
              onChange={(e) => {
                setPriority(Number(e.target.value))
                change()
              }}
            >
              <option value={0}>Low</option>
              <option value={5}>Normal</option>
              <option value={10}>High</option>
            </select>
          </Label>
          <Label className="col-span-full block space-y-1.5">
            <span className="text-xs text-muted-foreground">Scheduled UTC time (blank = now)</span>
            <Input
              placeholder="2026-10-01T09:00:00Z"
              value={at}
              onChange={(e) => {
                setAt(e.target.value)
                change()
              }}
            />
          </Label>
          {names.map((n) => (
            <Label className="block space-y-1.5" key={n}>
              <span className="text-xs text-muted-foreground">{n}</span>
              <Input
                value={variables[n] ?? ""}
                onChange={(e) => {
                  setVariables({ ...variables, [n]: e.target.value })
                  change()
                }}
              />
            </Label>
          ))}
        </CardContent>
        <CardFooter>
          <Button
            disabled={busy || !template || !user}
            onClick={async () => {
              const requestKey = key || crypto.randomUUID()
              setKey(requestKey)
              if (
                await send({
                  operation: "send",
                  templateId: Number(template),
                  userId: Number(user),
                  channel,
                  priority,
                  variables,
                  key: requestKey,
                  ...(at ? { at } : {}),
                })
              )
                setKey("")
            }}
          >
            Queue notification
          </Button>
        </CardFooter>
      </Card>

      <NotificationPreferences />

      <Card>
        <CardHeader>
          <CardTitle>Recent deliveries</CardTitle>
          <CardDescription>
            Accepted = provider accepted the request, not confirmed device delivery. Uncertain sends are never
            automatically retried; missing providers stay blocked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.deliveries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                      No deliveries yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.deliveries.map((d: any) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">#{d.id}</TableCell>
                    <TableCell>#{d.user_id}</TableCell>
                    <TableCell><Badge variant="outline">{d.channel}</Badge></TableCell>
                    <TableCell>{d.priority}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(d.status)}>
                        {d.status} {d.error_code}
                      </Badge>
                    </TableCell>
                    <TableCell>{d.attempts}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{d.available_at}</TableCell>
                    <TableCell className="text-right">
                      {["failed", "blocked"].includes(d.status) && (
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
              <CardTitle>Delivery history</CardTitle>
              <CardDescription>Full audit trail of notification delivery attempts.</CardDescription>
            </div>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", historyOpen && "rotate-180")} />
          </button>
        </CardHeader>
        {historyOpen && (
          <CardContent className="space-y-1.5">
            {data.history.length === 0 && <p className="text-sm text-muted-foreground">No history yet.</p>}
            {data.history.map((h: any, i: number) => (
              <p key={i} className="text-sm text-muted-foreground">
                #{h.delivery_id} · {h.status} · Attempt {h.attempt} · {h.created_at}
              </p>
            ))}
          </CardContent>
        )}
      </Card>
    </main>
  )
}
