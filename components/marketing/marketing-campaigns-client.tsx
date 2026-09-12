"use client"

import { useState } from "react"
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
import { Megaphone, Plus, DollarSign, TrendingUp } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

type Status = "Active" | "Scheduled" | "Completed" | "Draft"

type Campaign = {
  id: string
  name: string
  channel: string
  status: Status
  budget: number
  spent: number
  roi: string
}

const SEED: Campaign[] = []

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "outline"> = {
  Active: "default",
  Scheduled: "secondary",
  Completed: "outline",
  Draft: "outline",
}

const money = (n: number) => `$${n.toLocaleString()}`

function avgRoi(campaigns: Campaign[]) {
  const nums = campaigns
    .map((c) => Number.parseFloat(c.roi.replace("x", "")))
    .filter((n) => !Number.isNaN(n))
  if (nums.length === 0) return "—"
  return `${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)}x`
}

export function MarketingCampaignsClient() {
  const [campaigns, setCampaigns] = useState<Campaign[]>(SEED)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: "", channel: "", budget: "" })

  function add() {
    if (!form.name) return
    setCampaigns((prev) => [
      {
        id: `MC-${207 + prev.length}`,
        name: form.name,
        channel: form.channel || "Email",
        status: "Draft",
        budget: Number(form.budget) || 0,
        spent: 0,
        roi: "—",
      },
      ...prev,
    ])
    setForm({ name: "", channel: "", budget: "" })
    setOpen(false)
  }

  const totalBudget = campaigns.reduce((a, c) => a + c.budget, 0)
  const totalSpent = campaigns.reduce((a, c) => a + c.spent, 0)
  const active = campaigns.filter((c) => c.status === "Active").length

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
                {(
                  [
                    ["name", "Campaign name", "text"],
                    ["channel", "Channel", "text"],
                    ["budget", "Budget", "number"],
                  ] as const
                ).map(([key, label, type]) => (
                  <div key={key} className="flex flex-col gap-1.5">
                    <Label htmlFor={key} className="text-xs text-muted-foreground">
                      {label}
                    </Label>
                    <Input
                      id={key}
                      type={type}
                      value={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button onClick={add}>Create campaign</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Campaigns" value={active} icon={Megaphone} />
        <StatCard label="Total Budget" value={money(totalBudget)} icon={DollarSign} />
        <StatCard label="Spent" value={money(totalSpent)} hint={totalBudget > 0 ? `${Math.round((totalSpent / totalBudget) * 100)}% of budget` : undefined} icon={DollarSign} />
        <StatCard label="Avg. ROI" value={avgRoi(campaigns)} hint="Trailing 90 days" icon={TrendingUp} />
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
              {campaigns.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    No campaigns yet. Create your first campaign to get started.
                  </td>
                </tr>
              )}
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c.id}</div>
                  </td>
                  <td className="py-3 text-muted-foreground">{c.channel}</td>
                  <td className="py-3">
                    <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                  </td>
                  <td className="py-3 text-right tabular-nums">{money(c.budget)}</td>
                  <td className="py-3 text-right tabular-nums">{money(c.spent)}</td>
                  <td className="py-3 text-right font-medium tabular-nums">{c.roi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  )
}
