"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Copy, Check, Plus, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          toast.success("Copied to clipboard")
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Copy failed")
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}

export function InstallDialog({
  install,
  trackingId,
  trigger,
}: {
  install: { snippet: string; scriptUrl: string; collectUrl: string }
  trackingId: string
  trigger: React.ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Install tracking</DialogTitle>
          <DialogDescription>
            Paste this snippet just before the closing {"</head>"} tag on every page you want to track.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Tracking ID</Label>
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{trackingId}</code>
              <CopyButton text={trackingId} />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs text-muted-foreground">Snippet</Label>
              <CopyButton text={install.snippet} />
            </div>
            <pre className="w-full min-w-0 max-w-full overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
              <code className="whitespace-pre">{install.snippet}</code>
            </pre>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Track a conversion manually</p>
            <code className="block whitespace-pre-wrap font-mono">
              {`window.muenotAnalytics.conversion('Demo request', { plan: 'pro' })`}
            </code>
            <p className="mt-2">
              Form submissions, outbound links, downloads, scroll depth and page views are captured automatically. No
              personal field values are ever collected.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function NewPropertyDialog({ onCreated }: { onCreated: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [domain, setDomain] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!name.trim()) return toast.error("Name is required")
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/website-analytics/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, domain }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed")
      toast.success("Website added")
      setOpen(false)
      setName("")
      setDomain("")
      onCreated(json.id)
    } catch (e: any) {
      toast.error(e.message || "Failed to add website")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Add website
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a website</DialogTitle>
          <DialogDescription>Create a new tracked property with its own tracking ID.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-name">Name</Label>
            <Input id="wa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing site" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-domain">Primary domain (optional)</Label>
            <Input
              id="wa-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="www.example.com"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Adding…" : "Add website"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GoalsDialog({
  propertyId,
  goals,
  canManage,
  onChange,
  trigger,
}: {
  propertyId: number
  goals: any[]
  canManage: boolean
  onChange: () => void
  trigger: React.ReactNode
}) {
  const [name, setName] = useState("")
  const [matchType, setMatchType] = useState("event")
  const [eventType, setEventType] = useState("form_submit")
  const [target, setTarget] = useState("")
  const [saving, setSaving] = useState(false)

  async function addGoal() {
    if (!name.trim()) return toast.error("Goal name is required")
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/website-analytics/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId, name, match_type: matchType, event_type: eventType, target }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed")
      toast.success("Goal created")
      setName("")
      setTarget("")
      onChange()
    } catch (e: any) {
      toast.error(e.message || "Failed to create goal")
    } finally {
      setSaving(false)
    }
  }

  async function removeGoal(id: number) {
    try {
      const res = await fetch(`/api/marketing/website-analytics/goals/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed")
      toast.success("Goal removed")
      onChange()
    } catch {
      toast.error("Failed to remove goal")
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Conversion goals</DialogTitle>
          <DialogDescription>Define what counts as a conversion for this website.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {goals.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No goals yet.</p>
          ) : (
            goals.map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {g.match_type === "url" ? `URL = ${g.target}` : `Event = ${g.event_type}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={g.status === "Active" ? "default" : "secondary"}>{g.status}</Badge>
                  {canManage ? (
                    <Button size="icon" variant="ghost" onClick={() => removeGoal(g.id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        {canManage ? (
          <div className="mt-2 flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-name">New goal name</Label>
              <Input id="goal-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Lead form submission" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Match type</Label>
                <Select value={matchType} onValueChange={setMatchType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="event">Event</SelectItem>
                    <SelectItem value="url">Page URL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {matchType === "event" ? (
                <div className="flex flex-col gap-1.5">
                  <Label>Event</Label>
                  <Select value={eventType} onValueChange={setEventType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="form_submit">Form submit</SelectItem>
                      <SelectItem value="lead_conversion">Lead conversion</SelectItem>
                      <SelectItem value="cta_click">CTA click</SelectItem>
                      <SelectItem value="download">Download</SelectItem>
                      <SelectItem value="outbound_link">Outbound link</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="goal-target">Page path</Label>
                  <Input id="goal-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/thank-you" />
                </div>
              )}
            </div>
            <Button onClick={addGoal} disabled={saving} size="sm" className="self-start">
              <Plus className="size-4" /> {saving ? "Adding…" : "Add goal"}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export function SettingsDialog({
  property,
  canManage,
  onSaved,
  trigger,
}: {
  property: any
  canManage: boolean
  onSaved: () => void
  trigger: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [domain, setDomain] = useState(property.domain || "")
  const [status, setStatus] = useState(property.status)
  const [timeout, setTimeoutValue] = useState(String(property.session_timeout_minutes))
  const [retention, setRetention] = useState(String(property.retention_days))
  const [excludeBots, setExcludeBots] = useState(!!property.exclude_bots)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/marketing/website-analytics/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          status,
          session_timeout_minutes: Number(timeout),
          retention_days: Number(retention),
          exclude_bots: excludeBots,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Failed")
      toast.success("Settings saved")
      setOpen(false)
      onSaved()
    } catch (e: any) {
      toast.error(e.message || "Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tracking settings</DialogTitle>
          <DialogDescription>Configure {property.name}.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Primary domain</Label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} disabled={!canManage} placeholder="www.example.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus} disabled={!canManage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Paused">Paused</SelectItem>
                  <SelectItem value="Archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Session timeout (min)</Label>
              <Input
                type="number"
                value={timeout}
                onChange={(e) => setTimeoutValue(e.target.value)}
                disabled={!canManage}
                min={1}
                max={240}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Data retention (days)</Label>
            <Input
              type="number"
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              disabled={!canManage}
              min={30}
              max={2000}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">Exclude bots</span>
              <span className="text-xs text-muted-foreground">Filter known crawlers and monitors</span>
            </div>
            <Switch checked={excludeBots} onCheckedChange={setExcludeBots} disabled={!canManage} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
          {canManage ? (
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
