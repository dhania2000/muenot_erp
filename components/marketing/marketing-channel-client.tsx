"use client"

import { useState } from "react"
import type React from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { Plus, Send, MousePointerClick, Users } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

type Status = "Active" | "Scheduled" | "Sending" | "Completed" | "Draft"

export type ChannelCampaign = {
  id: string
  name: string
  status: Status
  audience: number
  sent: number
  engagement: string
}

export type ChannelConfig = {
  key: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  /** Label for the primary engagement metric column (e.g. "Open Rate"). */
  engagementLabel: string
  /** Label for the primary create button (e.g. "New Email Blast"). */
  createLabel: string
  /** Label for the reach/audience stat. */
  reachLabel: string
  seed: ChannelCampaign[]
}

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "outline"> = {
  Active: "default",
  Sending: "default",
  Scheduled: "secondary",
  Completed: "outline",
  Draft: "outline",
}

export function MarketingChannelClient({ config }: { config: ChannelConfig }) {
  const { icon: Icon } = config
  const [rows, setRows] = useState<ChannelCampaign[]>(config.seed)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: "", audience: "" })

  function add() {
    if (!form.name) return
    setRows((prev) => [
      {
        id: `${config.key.toUpperCase()}-${100 + prev.length + 1}`,
        name: form.name,
        status: "Draft",
        audience: Number(form.audience) || 0,
        sent: 0,
        engagement: "—",
      },
      ...prev,
    ])
    setForm({ name: "", audience: "" })
    setOpen(false)
  }

  const totalAudience = rows.reduce((a, c) => a + c.audience, 0)
  const totalSent = rows.reduce((a, c) => a + c.sent, 0)
  const active = rows.filter((c) => c.status === "Active" || c.status === "Sending").length

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing Campaigns"
        title={config.title}
        description={config.description}
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button>
                  <Plus className="size-4" />
                  {config.createLabel}
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{config.createLabel}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="name" className="text-xs text-muted-foreground">
                    Campaign name
                  </Label>
                  <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="audience" className="text-xs text-muted-foreground">
                    {config.reachLabel}
                  </Label>
                  <Input
                    id="audience"
                    type="number"
                    value={form.audience}
                    onChange={(e) => setForm({ ...form, audience: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button onClick={add}>Create</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active" value={active} icon={Icon} />
        <StatCard label={config.reachLabel} value={totalAudience.toLocaleString()} icon={Users} />
        <StatCard label="Messages Sent" value={totalSent.toLocaleString()} icon={Send} />
        <StatCard label={`Avg. ${config.engagementLabel}`} value={avgEngagement(rows)} icon={MousePointerClick} />
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="pb-3 font-medium">Campaign</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 text-right font-medium">{config.reachLabel}</th>
                <th className="pb-3 text-right font-medium">Sent</th>
                <th className="pb-3 text-right font-medium">{config.engagementLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c.id}</div>
                  </td>
                  <td className="py-3">
                    <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                  </td>
                  <td className="py-3 text-right tabular-nums">{c.audience.toLocaleString()}</td>
                  <td className="py-3 text-right tabular-nums">{c.sent.toLocaleString()}</td>
                  <td className="py-3 text-right font-medium tabular-nums">{c.engagement}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  )
}

function avgEngagement(rows: ChannelCampaign[]) {
  const nums = rows
    .map((r) => Number.parseFloat(r.engagement.replace("%", "")))
    .filter((n) => !Number.isNaN(n))
  if (nums.length === 0) return "—"
  return `${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)}%`
}
