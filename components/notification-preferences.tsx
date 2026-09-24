"use client"

import { useEffect, useState } from "react"
import { Bell, Mail, MessageSquare, Smartphone, Phone, ShieldCheck, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Frequency = "immediate" | "daily" | "off"
type ChannelPref = { channel: string; enabled: boolean; destination: string; minPriority: number; frequency: Frequency }
type ModulePref = { moduleKey: string; enabled: boolean }
type ModuleCatalogItem = { key: string; label: string }

const CHANNEL_META: Record<string, { label: string; icon: typeof Bell; hint: string; needsPhone?: boolean }> = {
  in_app: { label: "In-app", icon: Bell, hint: "Bell notifications inside the app." },
  email: { label: "Email", icon: Mail, hint: "Sent to your account email address." },
  push: { label: "Push", icon: Smartphone, hint: "Mobile push to your registered devices." },
  sms: { label: "SMS", icon: MessageSquare, hint: "Requires your international phone number.", needsPhone: true },
  whatsapp: { label: "WhatsApp", icon: Phone, hint: "Requires your international phone number.", needsPhone: true },
}

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "immediate", label: "Immediately" },
  { value: "daily", label: "Daily digest" },
  { value: "off", label: "Off" },
]

const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: "All notices" },
  { value: 5, label: "Normal & urgent" },
  { value: 10, label: "Urgent only" },
]

export function NotificationPreferences({ moduleCatalog = [] }: { moduleCatalog?: ModuleCatalogItem[] }) {
  const [channels, setChannels] = useState<ChannelPref[]>([])
  const [modules, setModules] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [savingChannel, setSavingChannel] = useState<string | null>(null)
  const [savingModule, setSavingModule] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/notification-preferences")
      .then(async (r) => {
        const b = await r.json()
        if (!r.ok) throw new Error(b.error)
        setChannels(b.channels)
        const map: Record<string, boolean> = {}
        for (const m of b.modules as ModulePref[]) map[m.moduleKey] = m.enabled
        setModules(map)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Unable to load preferences"))
      .finally(() => setLoading(false))
  }, [])

  function updateChannel(channel: string, patch: Partial<ChannelPref>) {
    setChannels((rows) => rows.map((r) => (r.channel === channel ? { ...r, ...patch } : r)))
  }

  async function saveChannel(row: ChannelPref) {
    setSavingChannel(row.channel)
    setError("")
    setMessage("")
    try {
      const r = await fetch("/api/notification-preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: row.channel,
          enabled: row.enabled,
          destination: row.destination,
          minPriority: row.minPriority,
          frequency: row.frequency,
        }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error)
      setMessage(`${CHANNEL_META[row.channel]?.label ?? row.channel} preferences saved`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save")
    } finally {
      setSavingChannel(null)
    }
  }

  async function saveModule(moduleKey: string, enabled: boolean) {
    setModules((m) => ({ ...m, [moduleKey]: enabled }))
    setSavingModule(moduleKey)
    setError("")
    setMessage("")
    try {
      const r = await fetch("/api/notification-preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "module", moduleKey, enabled }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error)
      setMessage("Module preferences saved")
    } catch (e) {
      setModules((m) => ({ ...m, [moduleKey]: !enabled }))
      setError(e instanceof Error ? e.message : "Unable to save")
    } finally {
      setSavingModule(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading your notification preferences...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Notification preferences</h1>
        <p className="text-sm text-muted-foreground">
          Choose how and when you are notified. Security and compliance alerts are always delivered and cannot be turned
          off.
        </p>
      </div>

      <Alert>
        <ShieldCheck className="size-4" aria-hidden="true" />
        <AlertTitle>Mandatory security notices are always on</AlertTitle>
        <AlertDescription>
          {
            "Critical security and compliance notifications ignore these settings so you never miss them. Everything else respects your choices below."
          }
        </AlertDescription>
      </Alert>

      {(message || error) && (
        <p
          role="status"
          aria-live="polite"
          className={error ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}
        >
          {error || message}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            Control each delivery channel, its cadence, and the minimum priority you want to receive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {channels.map((row, i) => {
            const meta = CHANNEL_META[row.channel] ?? { label: row.channel, icon: Bell, hint: "" }
            const Icon = meta.icon
            return (
              <div key={row.channel}>
                {i > 0 && <Separator className="mb-6" />}
                <div className="flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 rounded-md border bg-muted p-2 text-muted-foreground">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <div>
                        <Label htmlFor={`ch-${row.channel}`} className="text-base">
                          {meta.label}
                        </Label>
                        <p className="text-sm text-muted-foreground">{meta.hint}</p>
                      </div>
                    </div>
                    <Switch
                      id={`ch-${row.channel}`}
                      checked={row.enabled}
                      onCheckedChange={(v) => updateChannel(row.channel, { enabled: v })}
                      aria-label={`Enable ${meta.label} notifications`}
                    />
                  </div>

                  {row.enabled && (
                    <div className="flex flex-wrap items-end gap-4 pl-0 sm:pl-12">
                      {meta.needsPhone && (
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`dest-${row.channel}`} className="text-xs text-muted-foreground">
                            Phone number
                          </Label>
                          <Input
                            id={`dest-${row.channel}`}
                            className="w-48"
                            placeholder="+14155550123"
                            value={row.destination}
                            onChange={(e) => updateChannel(row.channel, { destination: e.target.value })}
                          />
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Frequency</Label>
                        <Select
                          value={row.frequency}
                          onValueChange={(v) => updateChannel(row.channel, { frequency: v as Frequency })}
                        >
                          <SelectTrigger className="w-40" aria-label={`${meta.label} frequency`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FREQUENCIES.map((f) => (
                              <SelectItem key={f.value} value={f.value}>
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Priority</Label>
                        <Select
                          value={String(row.minPriority)}
                          onValueChange={(v) => updateChannel(row.channel, { minPriority: Number(v) })}
                        >
                          <SelectTrigger className="w-44" aria-label={`${meta.label} minimum priority`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PRIORITIES.map((p) => (
                              <SelectItem key={p.value} value={String(p.value)}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={savingChannel === row.channel}
                      onClick={() => saveChannel(row)}
                    >
                      {savingChannel === row.channel && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                      Save {meta.label}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {moduleCatalog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Modules</CardTitle>
            <CardDescription>
              Mute activity notifications from modules you do not need. Mandatory notices are never muted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {moduleCatalog.map((m) => {
                const enabled = modules[m.key] ?? true
                return (
                  <div key={m.key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <Label htmlFor={`mod-${m.key}`} className="flex items-center gap-2">
                      {m.label}
                      {!enabled && (
                        <Badge variant="outline" className="text-xs font-normal">
                          Muted
                        </Badge>
                      )}
                    </Label>
                    <Switch
                      id={`mod-${m.key}`}
                      checked={enabled}
                      disabled={savingModule === m.key}
                      onCheckedChange={(v) => saveModule(m.key, v)}
                      aria-label={`Notifications for ${m.label}`}
                    />
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
