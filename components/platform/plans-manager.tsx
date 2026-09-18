"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  MODULE_CATALOG,
  QUOTA_DIMENSIONS,
  REPORT_LEVELS,
  SUPPORT_LEVELS,
  formatQuota,
  presetForCode,
  type PlanEntitlements,
} from "@/lib/platform/entitlements"
import { resolveAllFeatures, type FeatureState } from "@/lib/platform/feature-entitlements"
import { Pencil, Plus, Check, Package } from "lucide-react"

type Plan = {
  code: string
  name: string
  description: string | null
  price_monthly: number
  currency: string
  seat_limit: number | null
  features: string[]
  entitlements: PlanEntitlements
  is_active: boolean
  sort_order: number
}

type DraftEntitlements = {
  modules: string[]
  quotas: Record<string, string> // "" === unlimited
  reports: string
  support_level: string
  feature_flags: string
}

function toDraft(ent: PlanEntitlements): DraftEntitlements {
  const quotas: Record<string, string> = {}
  for (const q of QUOTA_DIMENSIONS) {
    const v = ent[q.key]
    quotas[q.key] = v == null ? "" : String(v)
  }
  return {
    modules: [...ent.modules],
    quotas,
    reports: ent.reports,
    support_level: ent.support_level,
    feature_flags: ent.feature_flags.join(", "),
  }
}

function draftToEntitlements(d: DraftEntitlements): Record<string, unknown> {
  return {
    modules: d.modules,
    ...Object.fromEntries(QUOTA_DIMENSIONS.map((q) => [q.key, d.quotas[q.key]])),
    reports: d.reports,
    support_level: d.support_level,
    feature_flags: d.feature_flags,
  }
}

type FormState = {
  code: string
  name: string
  description: string
  price_monthly: string
  currency: string
  seat_limit: string
  sort_order: string
  entitlements: DraftEntitlements
}

function planToForm(plan: Plan): FormState {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description ?? "",
    price_monthly: String(plan.price_monthly),
    currency: plan.currency,
    seat_limit: plan.seat_limit == null ? "" : String(plan.seat_limit),
    sort_order: String(plan.sort_order),
    entitlements: toDraft(plan.entitlements),
  }
}

// SPEC 18 — how each resolved feature state reads in the plan matrix.
const FEATURE_STATE_STYLE: Record<FeatureState, { label: string; className: string }> = {
  enabled: { label: "Enabled", className: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  limited: { label: "Limited", className: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  metered: { label: "Metered", className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  disabled: { label: "Disabled", className: "border-transparent bg-muted text-muted-foreground" },
}

function emptyForm(): FormState {
  return {
    code: "",
    name: "",
    description: "",
    price_monthly: "0",
    currency: "USD",
    seat_limit: "",
    sort_order: "0",
    entitlements: toDraft(presetForCode("starter")),
  }
}

export function PlansManager({
  plans,
  tenantCounts,
  canManage,
}: {
  plans: Plan[]
  tenantCounts: Record<string, number>
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isNew, setIsNew] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())

  function openEdit(plan: Plan) {
    setForm(planToForm(plan))
    setIsNew(false)
    setOpen(true)
  }

  function openCreate() {
    setForm(emptyForm())
    setIsNew(true)
    setOpen(true)
  }

  function toggleModule(key: string) {
    setForm((f) => {
      const has = f.entitlements.modules.includes(key)
      return {
        ...f,
        entitlements: {
          ...f.entitlements,
          modules: has
            ? f.entitlements.modules.filter((m) => m !== key)
            : [...f.entitlements.modules, key],
        },
      }
    })
  }

  function setQuota(key: string, value: string) {
    setForm((f) => ({
      ...f,
      entitlements: { ...f.entitlements, quotas: { ...f.entitlements.quotas, [key]: value } },
    }))
  }

  function applyPreset(code: string) {
    setForm((f) => ({ ...f, entitlements: toDraft(presetForCode(code)) }))
  }

  async function save() {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error("Plan code and name are required")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/platform/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code,
          name: form.name,
          description: form.description || null,
          price_monthly: Number(form.price_monthly) || 0,
          currency: form.currency || "USD",
          seat_limit: form.seat_limit === "" ? null : Number(form.seat_limit),
          sort_order: Number(form.sort_order) || 0,
          entitlements: draftToEntitlements(form.entitlements),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error ?? "Failed to save plan")
      toast.success(isNew ? "Plan created" : "Plan updated")
      setOpen(false)
      router.refresh()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save plan")
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(plan: Plan) {
    try {
      const res = await fetch("/api/platform/plans", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: plan.code, active: !plan.is_active }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error ?? "Failed to update plan")
      toast.success(plan.is_active ? "Plan deactivated" : "Plan activated")
      router.refresh()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update plan")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="size-4" />
            New plan
          </Button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => {
          const ent = plan.entitlements
          const count = tenantCounts[plan.code] ?? 0
          return (
            <Card key={plan.code} className={plan.is_active ? "" : "opacity-70"}>
              <CardHeader className="gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Package className="size-4 text-muted-foreground" />
                      {plan.name}
                    </CardTitle>
                    <span className="font-mono text-xs text-muted-foreground">{plan.code}</span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant={plan.is_active ? "default" : "secondary"}>
                      {plan.is_active ? "Active" : "Inactive"}
                    </Badge>
                    <span className="text-sm font-semibold">
                      {plan.currency} {plan.price_monthly}
                      <span className="text-xs font-normal text-muted-foreground">/mo</span>
                    </span>
                  </div>
                </div>
                {plan.description && (
                  <p className="text-sm text-muted-foreground">{plan.description}</p>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Modules ({ent.modules.length})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {ent.modules.length === 0 && (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                    {ent.modules.map((m) => {
                      const label = MODULE_CATALOG.find((c) => c.key === m)?.label ?? m
                      return (
                        <Badge key={m} variant="outline" className="text-xs">
                          {label}
                        </Badge>
                      )
                    })}
                  </div>
                </div>

                <Separator />

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  {QUOTA_DIMENSIONS.map((q) => (
                    <div key={q.key} className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">{q.label}</dt>
                      <dd className="font-medium tabular-nums">{formatQuota(ent[q.key])}</dd>
                    </div>
                  ))}
                </dl>

                <Separator />

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span>
                    <span className="text-muted-foreground">Reports: </span>
                    <span className="font-medium capitalize">{ent.reports}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Support: </span>
                    <span className="font-medium capitalize">{ent.support_level}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Tenants: </span>
                    <span className="font-medium tabular-nums">{count}</span>
                  </span>
                </div>

                {ent.feature_flags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {ent.feature_flags.map((f) => (
                      <Badge key={f} variant="secondary" className="text-xs">
                        {f}
                      </Badge>
                    ))}
                  </div>
                )}

                <Separator />

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Features
                  </span>
                  <ul className="flex flex-col gap-1">
                    {resolveAllFeatures(ent).map((f) => {
                      const style = FEATURE_STATE_STYLE[f.state]
                      return (
                        <li key={f.key} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-muted-foreground">{f.label}</span>
                          <span className="flex items-center gap-1.5">
                            {(f.state === "limited" || f.state === "metered") && f.limit != null && (
                              <span className="tabular-nums text-muted-foreground">{f.limit}</span>
                            )}
                            <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${style.className}`}>
                              {style.label}
                            </Badge>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>

                {canManage && (
                  <div className="mt-1 flex items-center gap-2">
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openEdit(plan)}>
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleActive(plan)}>
                      {plan.is_active ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{isNew ? "New plan" : `Edit ${form.name}`}</DialogTitle>
            <DialogDescription>
              Set pricing and the entitlement contract. Blank quota = unlimited.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-5 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-code">Code</Label>
                <Input
                  id="plan-code"
                  value={form.code}
                  disabled={!isNew}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="growth"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-name">Name</Label>
                <Input
                  id="plan-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Growth"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-desc">Description</Label>
              <Textarea
                id="plan-desc"
                value={form.description}
                rows={2}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-price">Price/mo</Label>
                <Input
                  id="plan-price"
                  type="number"
                  min={0}
                  value={form.price_monthly}
                  onChange={(e) => setForm((f) => ({ ...f, price_monthly: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-currency">Currency</Label>
                <Input
                  id="plan-currency"
                  value={form.currency}
                  onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-seats">Seat limit</Label>
                <Input
                  id="plan-seats"
                  type="number"
                  min={0}
                  placeholder="∞"
                  value={form.seat_limit}
                  onChange={(e) => setForm((f) => ({ ...f, seat_limit: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-sort">Sort</Label>
                <Input
                  id="plan-sort"
                  type="number"
                  value={form.sort_order}
                  onChange={(e) => setForm((f) => ({ ...f, sort_order: e.target.value }))}
                />
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Entitlements</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Apply preset:</span>
                {(["trial", "starter", "growth", "enterprise"] as const).map((code) => (
                  <Button
                    key={code}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs capitalize"
                    onClick={() => applyPreset(code)}
                  >
                    {code}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Modules</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {MODULE_CATALOG.map((m) => {
                  const on = form.entitlements.modules.includes(m.key)
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => toggleModule(m.key)}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                        on
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      <span
                        className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                          on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                        }`}
                      >
                        {on && <Check className="size-3" />}
                      </span>
                      {m.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Quotas <span className="font-normal text-muted-foreground">(blank = unlimited)</span></Label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {QUOTA_DIMENSIONS.map((q) => (
                  <div key={q.key} className="flex flex-col gap-1">
                    <Label htmlFor={`q-${q.key}`} className="text-xs text-muted-foreground">
                      {q.label} <span className="text-[10px]">{q.unit}</span>
                    </Label>
                    <Input
                      id={`q-${q.key}`}
                      type="number"
                      min={0}
                      placeholder="∞"
                      value={form.entitlements.quotas[q.key] ?? ""}
                      onChange={(e) => setQuota(q.key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Report tier</Label>
                <Select
                  value={form.entitlements.reports}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, entitlements: { ...f.entitlements, reports: v } }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPORT_LEVELS.map((l) => (
                      <SelectItem key={l} value={l} className="capitalize">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Support level</Label>
                <Select
                  value={form.entitlements.support_level}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, entitlements: { ...f.entitlements, support_level: v } }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORT_LEVELS.map((l) => (
                      <SelectItem key={l} value={l} className="capitalize">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-flags">
                Feature flags <span className="font-normal text-muted-foreground">(comma-separated)</span>
              </Label>
              <Input
                id="plan-flags"
                value={form.entitlements.feature_flags}
                placeholder="beta_dashboard, advanced_export"
                onChange={(e) =>
                  setForm((f) => ({ ...f, entitlements: { ...f.entitlements, feature_flags: e.target.value } }))
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving..." : isNew ? "Create plan" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
