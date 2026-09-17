"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Megaphone, Plus, DollarSign, TrendingUp } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

const CAMPAIGN_TYPES = ["Newsletter", "Promotional", "Announcement", "Transactional", "Re-engagement"] as const

// Backend campaign statuses mapped to the display badge + variant used here.
const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Sending: "default",
  Sent: "outline",
  Scheduled: "secondary",
  Draft: "outline",
  Paused: "secondary",
  Cancelled: "outline",
  Failed: "outline",
}

type CampaignRow = {
  id: number
  campaign_code: string
  name: string
  type: string
  status: string
  budget: number | string
  spent: number | string
  revenue: number | string
}

type Stats = {
  active: number
  total_budget: number
  total_spent: number
  avg_roi: number | null
}

type CampaignsResponse = {
  campaigns: CampaignRow[]
  total: number
  stats: Stats
}

const money = (n: number) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

export function MarketingCampaignsClient() {
  const { data, isLoading, mutate } = useSWR<CampaignsResponse>(
    "/api/marketing/campaigns?pageSize=100&sort=created_at&dir=desc",
    fetcher,
  )
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ name: "", type: "Newsletter", budget: "" })

  const campaigns = data?.campaigns ?? []
  const stats = data?.stats

  async function add() {
    if (!form.name.trim() || saving) return
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          budget: Number(form.budget) || 0,
        }),
      })
      if (!res.ok) return
      setForm({ name: "", type: "Newsletter", budget: "" })
      setOpen(false)
      await mutate()
    } finally {
      setSaving(false)
    }
  }

  const active = stats?.active ?? 0
  const totalBudget = stats?.total_budget ?? 0
  const totalSpent = stats?.total_spent ?? 0
  const roi = stats?.avg_roi

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Marketing Campaigns"
        description="Plan, budget, and track the performance of every campaign across your marketing channels."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button>
                  <Plus className="size-4" />
                  New Campaign
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>New Campaign</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="name" className="text-xs text-muted-foreground">
                    Campaign name
                  </Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="type" className="text-xs text-muted-foreground">
                    Type
                  </Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                    <SelectTrigger id="type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMPAIGN_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="budget" className="text-xs text-muted-foreground">
                    Budget
                  </Label>
                  <Input
                    id="budget"
                    type="number"
                    min={0}
                    value={form.budget}
                    onChange={(e) => setForm({ ...form, budget: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button onClick={add} disabled={saving || !form.name.trim()}>
                  {saving ? "Creating…" : "Create campaign"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Campaigns" value={active} icon={Megaphone} />
        <StatCard label="Total Budget" value={money(totalBudget)} icon={DollarSign} />
        <StatCard
          label="Spent"
          value={money(totalSpent)}
          hint={totalBudget > 0 ? `${Math.round((totalSpent / totalBudget) * 100)}% of budget` : undefined}
          icon={DollarSign}
        />
        <StatCard
          label="Avg. ROI"
          value={roi != null ? `${roi.toFixed(1)}x` : "—"}
          hint="Trailing 90 days"
          icon={TrendingUp}
        />
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="pb-3 font-medium">Campaign</th>
                <th className="pb-3 font-medium">Channel</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 text-right font-medium">Budget</th>
                <th className="pb-3 text-right font-medium">Spent</th>
                <th className="pb-3 text-right font-medium">ROI</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    Loading campaigns…
                  </td>
                </tr>
              )}
              {!isLoading && campaigns.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    No campaigns yet. Create your first campaign to get started.
                  </td>
                </tr>
              )}
              {campaigns.map((c) => {
                const budget = Number(c.budget) || 0
                const spent = Number(c.spent) || 0
                const revenue = Number(c.revenue) || 0
                const rowRoi = spent > 0 ? `${(revenue / spent).toFixed(1)}x` : "—"
                return (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-3">
                      <div className="font-medium">{c.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{c.campaign_code}</div>
                    </td>
                    <td className="py-3 text-muted-foreground">{c.type}</td>
                    <td className="py-3">
                      <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>{c.status}</Badge>
                    </td>
                    <td className="py-3 text-right tabular-nums">{money(budget)}</td>
                    <td className="py-3 text-right tabular-nums">{money(spent)}</td>
                    <td className="py-3 text-right font-medium tabular-nums">{rowRoi}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  )
}
