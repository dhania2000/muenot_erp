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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatMoney, Pill, StatCard, type CouponRow } from "./engine-shared"

const KEY = "/api/billing/coupons"

export function CouponConsole() {
  const { data, isLoading, mutate } = useSWR<{ coupons: CouponRow[] }>(KEY, fetcher)
  const [open, setOpen] = useState(false)
  const coupons = data?.coupons ?? []
  const active = coupons.filter((c) => c.is_active).length
  const redemptions = coupons.reduce((s, c) => s + c.times_redeemed, 0)

  async function toggle(c: CouponRow) {
    try {
      const res = await fetch(`${KEY}/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !c.is_active }),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Update failed")
      toast.success(c.is_active ? "Coupon disabled" : "Coupon enabled")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Coupons</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Percentage or fixed-amount discount codes with redemption caps, minimum spend, validity windows and
            once / repeating / forever durations. Applied on invoices at generation time.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setOpen(true)}>
          New coupon
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total coupons" value={String(coupons.length)} />
        <StatCard label="Active" value={String(active)} />
        <StatCard label="Total redemptions" value={String(redemptions)} />
        <StatCard label="Inactive" value={String(coupons.length - active)} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">All coupons</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading coupons…</div>
          ) : coupons.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">No coupons yet.</p>
              <Button onClick={() => setOpen(true)}>Create a coupon</Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Redemptions</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {coupons.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.coupon_code}</TableCell>
                      <TableCell className="max-w-[180px] truncate">{c.name}</TableCell>
                      <TableCell>
                        {c.discount_type === "percent" ? `${c.value}%` : formatMoney(c.value, c.currency)}
                      </TableCell>
                      <TableCell className="capitalize">
                        {c.duration}
                        {c.duration === "repeating" && c.duration_months ? ` · ${c.duration_months}mo` : ""}
                      </TableCell>
                      <TableCell>
                        {c.times_redeemed}
                        {c.max_redemptions ? ` / ${c.max_redemptions}` : ""}
                      </TableCell>
                      <TableCell>
                        {c.is_active ? (
                          <Pill tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Active</Pill>
                        ) : (
                          <Pill>Inactive</Pill>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => toggle(c)}>
                          {c.is_active ? "Disable" : "Enable"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateCouponDialog open={open} onOpenChange={setOpen} onCreated={() => { setOpen(false); mutate() }} />
    </div>
  )
}

function CreateCouponDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [discountType, setDiscountType] = useState<"percent" | "fixed">("percent")
  const [value, setValue] = useState("10")
  const [duration, setDuration] = useState<"once" | "forever" | "repeating">("once")
  const [durationMonths, setDurationMonths] = useState("3")
  const [minAmount, setMinAmount] = useState("")
  const [maxRedemptions, setMaxRedemptions] = useState("")
  const [validUntil, setValidUntil] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      const res = await fetch(KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name,
          discount_type: discountType,
          value: Number(value) || 0,
          duration,
          duration_months: duration === "repeating" ? Number(durationMonths) || null : null,
          min_amount: minAmount ? Number(minAmount) : null,
          max_redemptions: maxRedemptions ? Number(maxRedemptions) : null,
          valid_until: validUntil || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to create coupon")
      toast.success(`Coupon ${json.coupon.coupon_code} created`)
      onCreated()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New coupon</DialogTitle>
          <DialogDescription>Create a discount code customers can apply to invoices.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SAVE20" />
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch promo" />
            </div>
            <div className="space-y-1.5">
              <Label>Discount type</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as typeof discountType)}
              >
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Value</Label>
              <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Duration</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={duration}
                onChange={(e) => setDuration(e.target.value as typeof duration)}
              >
                <option value="once">Once</option>
                <option value="repeating">Repeating</option>
                <option value="forever">Forever</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Repeating months</Label>
              <Input
                type="number"
                value={durationMonths}
                disabled={duration !== "repeating"}
                onChange={(e) => setDurationMonths(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Minimum spend</Label>
              <Input type="number" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label>Max redemptions</Label>
              <Input type="number" value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} placeholder="Unlimited" />
            </div>
            <div className="space-y-1.5">
              <Label>Valid until</Label>
              <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Creating…" : "Create coupon"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
