"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus } from "lucide-react"
import type { FeatureFlag } from "@/lib/platform-console"
import { formatDateTime } from "@/lib/platform-format"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function FeatureFlagsManager({ flags }: { flags: FeatureFlag[] }) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  async function toggle(flag: FeatureFlag, enabled: boolean) {
    setPending(flag.key)
    try {
      const res = await fetch("/api/platform/feature-flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: flag.key, enabled }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not update flag")
        return
      }
      toast.success(`${flag.name} ${enabled ? "enabled" : "disabled"}`)
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New flag
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {flags.map((f) => (
          <Card key={f.key}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {f.name}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                      {f.key}
                    </code>
                  </CardTitle>
                  <CardDescription>{f.description}</CardDescription>
                </div>
                <Switch
                  checked={f.enabled}
                  disabled={pending === f.key}
                  onCheckedChange={(v) => toggle(f, v)}
                  aria-label={`Toggle ${f.name}`}
                />
              </div>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{f.rollout_percentage}% rollout</Badge>
                {f.override_count ? <Badge variant="secondary">{f.override_count} overrides</Badge> : null}
              </div>
              <span>Updated {formatDateTime(f.updated_at)}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <CreateFlagDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => router.refresh()} />
    </div>
  )
}

function CreateFlagDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [rollout, setRollout] = useState("0")
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch("/api/platform/feature-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          name,
          description,
          enabled,
          rollout_percentage: Number(rollout),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not create flag")
        return
      }
      toast.success(`Created flag ${name}`)
      onOpenChange(false)
      setKey("")
      setName("")
      setDescription("")
      setRollout("0")
      setEnabled(false)
      onCreated()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New feature flag</DialogTitle>
          <DialogDescription>Define a platform-wide flag. Keys are lowercase with underscores.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="flag-key">Key</Label>
              <Input id="flag-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="new_feature" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="flag-name">Name</Label>
              <Input id="flag-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New feature" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="flag-desc">Description</Label>
            <Textarea
              id="flag-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this flag control?"
              rows={2}
            />
          </div>
          <div className="flex items-end gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="flag-rollout">Rollout %</Label>
              <Input
                id="flag-rollout"
                type="number"
                min={0}
                max={100}
                value={rollout}
                onChange={(e) => setRollout(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch id="flag-enabled" checked={enabled} onCheckedChange={setEnabled} />
              <Label htmlFor="flag-enabled">Enabled</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !key.trim() || !name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create flag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
