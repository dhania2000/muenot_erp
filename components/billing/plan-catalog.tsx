"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatMoney, type Plan } from "./billing-shared"

const EMPTY = {
  name: "",
  description: "",
  currency: "USD",
  price_monthly: 0,
  price_yearly: 0,
  price_two_year: 0,
  price_five_year: 0,
  price_enterprise: 0,
  trial_days: 14,
  seats: "" as number | string,
  past_due_days: 7,
  grace_days: 14,
  suspend_days: 30,
  is_active: true,
}

export function PlanCatalog() {
  const { data, isLoading, mutate } = useSWR<{ plans: Plan[] }>("/api/billing/plans", fetcher)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Plan | null>(null)

  const plans = data?.plans ?? []

  function openCreate() {
    setEditing(null)
    setOpen(true)
  }
  function openEdit(p: Plan) {
    setEditing(p)
    setOpen(true)
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Plan Management</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Define the plans and per-term pricing (monthly, yearly, 2-year, 5-year) that tenants subscribe to.
          </p>
        </div>
        <Button className="shrink-0" onClick={openCreate}>
          New plan
        </Button>
      </header>

      {isLoading ? (
        <Card className="mt-6">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">Loading plans…</CardContent>
        </Card>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-medium">{p.name}</CardTitle>
                  <Badge variant={p.is_active ? "secondary" : "outline"} className="text-xs">
                    {p.is_active ? "Active" : "Draft"}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">{p.plan_code}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <p className="min-h-10 text-sm text-muted-foreground">{p.description || "—"}</p>
                <dl className="space-y-1 text-sm">
                  <PriceRow label="Monthly" value={formatMoney(p.price_monthly, p.currency)} />
                  <PriceRow label="Yearly" value={formatMoney(p.price_yearly, p.currency)} />
                  <PriceRow label="2-Year" value={formatMoney(p.price_two_year, p.currency)} />
                  <PriceRow label="5-Year" value={formatMoney(p.price_five_year, p.currency)} />
                  <PriceRow label="Enterprise" value={formatMoney(p.price_enterprise, p.currency)} />
                </dl>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{p.seats == null ? "Unlimited seats" : `${p.seats} seats`}</span>
                  <span>{p.trial_days}d trial</span>
                  <span>Grace {p.grace_days}d</span>
                </div>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => openEdit(p)}>
                  Edit plan
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PlanDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        onSaved={() => {
          setOpen(false)
          mutate()
        }}
      />
    </div>
  )
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  )
}

function PlanDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: Plan | null
  onSaved: () => void
}) {
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [initedFor, setInitedFor] = useState<number | null | "new">(null)

  // Sync the form when the dialog opens for a different plan.
  const key = editing?.id ?? "new"
  if (open && initedFor !== key) {
    setInitedFor(key)
    setForm(
      editing
        ? {
            name: editing.name,
            description: editing.description ?? "",
            currency: editing.currency,
            price_monthly: editing.price_monthly,
            price_yearly: editing.price_yearly,
            price_two_year: editing.price_two_year,
            price_five_year: editing.price_five_year,
            price_enterprise: editing.price_enterprise,
            trial_days: editing.trial_days,
            seats: editing.seats ?? "",
            past_due_days: editing.past_due_days,
            grace_days: editing.grace_days,
            suspend_days: editing.suspend_days,
            is_active: editing.is_active,
          }
        : EMPTY,
    )
  }
  if (!open && initedFor !== null) setInitedFor(null)

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }
  function num(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => set(k, (e.target.value === "" ? "" : Number(e.target.value)) as never)
  }

  async function submit() {
    setSaving(true)
    try {
      const url = editing ? `/api/billing/plans/${editing.id}` : "/api/billing/plans"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, seats: form.seats === "" ? null : form.seats }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to save plan")
      toast.success(editing ? "Plan updated" : "Plan created")
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit plan" : "New plan"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Growth" />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
            </div>
            <div className="space-y-1.5">
              <Label>Seats (blank = unlimited)</Label>
              <Input type="number" value={form.seats} onChange={num("seats")} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Monthly price</Label>
              <Input type="number" value={form.price_monthly} onChange={num("price_monthly")} />
            </div>
            <div className="space-y-1.5">
              <Label>Yearly price</Label>
              <Input type="number" value={form.price_yearly} onChange={num("price_yearly")} />
            </div>
            <div className="space-y-1.5">
              <Label>2-Year price</Label>
              <Input type="number" value={form.price_two_year} onChange={num("price_two_year")} />
            </div>
            <div className="space-y-1.5">
              <Label>5-Year price</Label>
              <Input type="number" value={form.price_five_year} onChange={num("price_five_year")} />
            </div>
            <div className="space-y-1.5">
              <Label>Enterprise price</Label>
              <Input type="number" value={form.price_enterprise} onChange={num("price_enterprise")} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Trial days</Label>
              <Input type="number" value={form.trial_days} onChange={num("trial_days")} />
            </div>
            <div className="space-y-1.5">
              <Label>Past due</Label>
              <Input type="number" value={form.past_due_days} onChange={num("past_due_days")} />
            </div>
            <div className="space-y-1.5">
              <Label>Grace</Label>
              <Input type="number" value={form.grace_days} onChange={num("grace_days")} />
            </div>
            <div className="space-y-1.5">
              <Label>Suspend</Label>
              <Input type="number" value={form.suspend_days} onChange={num("suspend_days")} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label className="text-sm">Active (available to subscribe)</Label>
            <Switch checked={form.is_active} onCheckedChange={(v) => set("is_active", v)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
