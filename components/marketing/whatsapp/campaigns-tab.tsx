"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Plus, Loader2, Send, Pause, Play, X, Megaphone } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { CAMPAIGN_TYPES } from "@/lib/whatsapp-config"
import { cn } from "@/lib/utils"
import { NativeSelect, TabState, formatDateTime } from "./shared"
import type { Audience, Campaign, WhatsAppCaps } from "./types"

const STATUS_STYLE: Record<string, string> = {
  draft: "border-transparent bg-muted-foreground text-white",
  scheduled: "border-transparent bg-blue-500 text-white",
  running: "border-transparent bg-amber-500 text-white",
  paused: "border-transparent bg-amber-600 text-white",
  completed: "border-transparent bg-[#25D366] text-white",
  failed: "border-transparent bg-destructive text-white",
  cancelled: "border-transparent bg-muted-foreground text-white",
}

/** Campaign broadcast manager: create, schedule, launch, pause and track. */
export function CampaignsTab({ caps }: { caps: WhatsAppCaps | null }) {
  const { data, isLoading, mutate } = useSWR<{ campaigns: Campaign[] }>(
    "/api/marketing/whatsapp/campaigns",
    fetcher,
  )
  const campaigns = data?.campaigns ?? []
  const canManage = caps?.canCreateCampaigns ?? false

  async function action(id: number, act: "launch" | "pause" | "resume" | "cancel") {
    const res = await fetch(`/api/marketing/whatsapp/campaigns/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: act }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || "Action failed")
      return
    }
    toast.success(`Campaign ${act === "launch" ? "launched" : act + "d"}`)
    mutate()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Send approved-template broadcasts to a saved audience. Sends respect opt-in, templates and Meta rate limits.
        </p>
        {canManage ? <CampaignDialog onSaved={() => mutate()} /> : null}
      </div>

      {isLoading ? (
        <TabState loading>Loading campaigns…</TabState>
      ) : campaigns.length === 0 ? (
        <TabState>No campaigns yet.</TabState>
      ) : (
        <div className="flex flex-col gap-3">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardHeader className="gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Megaphone className="size-4 text-muted-foreground" />
                    {c.name}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge className={cn("text-[10px] uppercase", STATUS_STYLE[c.status] ?? STATUS_STYLE.draft)}>
                      {c.status}
                    </Badge>
                    {canManage ? (
                      <CampaignActions campaign={c} onAction={action} />
                    ) : null}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.type} · template {c.templateName ?? "—"} · {c.audienceName ? `audience "${c.audienceName}"` : "no audience"}
                  {c.scheduledAt ? ` · scheduled ${formatDateTime(c.scheduledAt)}` : ""}
                </p>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-3 text-center sm:grid-cols-6">
                <Metric label="Recipients" value={c.totalRecipients} />
                <Metric label="Sent" value={c.sentCount} />
                <Metric label="Delivered" value={c.deliveredCount} />
                <Metric label="Read" value={c.readCount} />
                <Metric label="Replied" value={c.repliedCount} />
                <Metric label="Failed" value={c.failedCount} />
                {c.lastError ? (
                  <p className="col-span-full text-left text-xs text-destructive">{c.lastError}</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

function CampaignActions({
  campaign,
  onAction,
}: {
  campaign: Campaign
  onAction: (id: number, act: "launch" | "pause" | "resume" | "cancel") => void
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const s = campaign.status

  return (
    <div className="flex items-center gap-1">
      {(s === "draft" || s === "scheduled") ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger render={<Button size="sm"><Send className="size-4" /> Launch</Button>} />
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Launch campaign?</DialogTitle>
              <DialogDescription>
                You are about to send &quot;{campaign.name}&quot; to {campaign.totalRecipients || "the resolved"} contacts using
                template {campaign.templateName}. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Cancel</Button>} />
              <Button
                onClick={() => {
                  onAction(campaign.id, "launch")
                  setConfirmOpen(false)
                }}
              >
                <Send className="size-4" /> Confirm launch
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {s === "running" ? (
        <Button size="sm" variant="outline" onClick={() => onAction(campaign.id, "pause")}>
          <Pause className="size-4" /> Pause
        </Button>
      ) : null}
      {s === "paused" ? (
        <Button size="sm" variant="outline" onClick={() => onAction(campaign.id, "resume")}>
          <Play className="size-4" /> Resume
        </Button>
      ) : null}
      {(s === "running" || s === "paused" || s === "scheduled") ? (
        <Button size="sm" variant="ghost" onClick={() => onAction(campaign.id, "cancel")} aria-label="Cancel campaign">
          <X className="size-4 text-destructive" />
        </Button>
      ) : null}
    </div>
  )
}

function CampaignDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const { data: audienceData } = useSWR<{ audiences: Audience[] }>(
    open ? "/api/marketing/whatsapp/audiences" : null,
    fetcher,
  )
  const audiences = audienceData?.audiences ?? []

  const [form, setForm] = React.useState({
    name: "",
    type: "promotional",
    audienceId: "",
    templateName: "",
    templateLanguage: "en_US",
    scheduledAt: "",
  })

  async function save() {
    if (!form.name.trim() || !form.templateName.trim()) {
      toast.error("Campaign name and template are required.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          audienceId: form.audienceId ? Number(form.audienceId) : null,
          templateName: form.templateName,
          templateLanguage: form.templateLanguage,
          scheduledAt: form.scheduledAt || null,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to create campaign")
      toast.success("Campaign created as draft")
      setOpen(false)
      setForm({ name: "", type: "promotional", audienceId: "", templateName: "", templateLanguage: "en_US", scheduledAt: "" })
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" /> New campaign</Button>} />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a campaign</DialogTitle>
          <DialogDescription>Saved as a draft. Launch it (with confirmation) once recipients are ready.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cp-name" className="text-xs text-muted-foreground">Campaign name</Label>
            <Input id="cp-name" placeholder="e.g. Diwali Offer 2026" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Type</Label>
              <NativeSelect value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                {CAMPAIGN_TYPES.map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Audience</Label>
              <NativeSelect value={form.audienceId} onChange={(e) => setForm((f) => ({ ...f, audienceId: e.target.value }))}>
                <option value="">All opted-in contacts</option>
                {audiences.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cp-tpl" className="text-xs text-muted-foreground">Template name</Label>
              <Input id="cp-tpl" placeholder="diwali_offer" value={form.templateName} onChange={(e) => setForm((f) => ({ ...f, templateName: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cp-lang" className="text-xs text-muted-foreground">Language</Label>
              <Input id="cp-lang" value={form.templateLanguage} onChange={(e) => setForm((f) => ({ ...f, templateLanguage: e.target.value }))} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cp-when" className="text-xs text-muted-foreground">Schedule (optional)</Label>
            <Input id="cp-when" type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm((f) => ({ ...f, scheduledAt: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
