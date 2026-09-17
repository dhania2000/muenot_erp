"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AlertTriangle,
  CalendarClock,
  CreditCard,
  Download,
  LayoutGrid,
  Plus,
  RefreshCw,
  Search,
  Users,
  Wallet,
  X,
} from "lucide-react"

// ── Types (mirrored from the API) ────────────────────────────────────────────

type Summary = {
  total: number
  active: number
  trial: number
  suspended: number
  cancelled: number
  expired: number
  expiring_soon: number
  seats_total: number
  seats_used: number
  monthly_spend: number
  annual_spend: number
}

type SubscriptionRow = {
  subscription_id: string
  service_name: string
  category: string | null
  vendor_party_id: string | null
  vendor_name: string | null
  plan_name: string | null
  description: string | null
  billing_cycle: string
  currency: string
  amount: number
  monthly_cost: number
  annual_cost: number
  seats_total: number
  seats_used: number
  seats_available: number
  auto_renew: boolean
  start_date: string | null
  end_date: string | null
  trial_end_date: string | null
  cancellation_date: string | null
  payment_method: string | null
  account_email: string | null
  owner_user_id: number | null
  owner_name: string | null
  department: string | null
  status: string
  effective_status: string
  expiring_soon: boolean
  days_to_expiry: number | null
  reminder_days: number
  notes: string | null
}

type ListResponse = { rows: SubscriptionRow[]; summary: Summary }

type Detail = {
  subscription: SubscriptionRow
  seats: {
    seat_id: string
    employee_id: number
    employee_ref: string | null
    employee_name: string | null
    department: string | null
    assigned_date: string | null
    revoked_date: string | null
    status: string
    remarks: string | null
    assigned_by_name: string | null
  }[]
  renewals: {
    action: string
    previous_end_date: string | null
    new_end_date: string | null
    amount: number | null
    currency: string | null
    billing_cycle: string | null
    remarks: string | null
    performed_by_name: string | null
    created_at: string
  }[]
  audit: { action: string; user_name: string | null; reason: string | null; created_at: string }[]
  documents: {
    id: number
    label: string | null
    doc_type: string | null
    file_url: string
    file_name: string | null
    uploaded_by_name: string | null
    created_at: string
  }[]
}

type Lookups = {
  vendors: { party_id: string; name: string | null }[]
  employees: { id: number; employee_name: string | null; employee_id: string | null; department: string | null }[]
  departments: string[]
  services: { id: number; name: string; category: string | null }[]
}

type Analytics = {
  summary: Summary
  by_category: { label: string; monthly: number; annual: number }[]
  by_vendor: { label: string; monthly: number; annual: number }[]
  by_department: { label: string; monthly: number; annual: number }[]
  upcoming_renewals: {
    subscription_id: string
    service_name: string
    vendor_name: string | null
    end_date: string | null
    days_to_expiry: number | null
    amount: number
    currency: string
    auto_renew: boolean
  }[]
}

// ── Constants + helpers ────────────────────────────────────────────────────────

const BILLING_CYCLES = ["Monthly", "Quarterly", "Half-Yearly", "Annual", "One-Time"]
const CATEGORIES = [
  "Software / SaaS",
  "Cloud / Hosting",
  "License",
  "Membership",
  "Domain",
  "Telecom / Internet",
  "Maintenance / AMC",
  "Other",
]
const STATUSES = ["Active", "Trial", "Suspended", "Cancelled", "Expired"]

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const inr = (v: number | null | undefined) =>
  v == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v)

const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"

const fmtDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"

function statusBadge(row: Pick<SubscriptionRow, "effective_status" | "expiring_soon" | "days_to_expiry">) {
  const s = row.effective_status
  const map: Record<string, string> = {
    Active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    Trial: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
    Suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    Cancelled: "bg-muted text-muted-foreground",
    Expired: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  }
  return (
    <div className="flex flex-col gap-1">
      <Badge variant="secondary" className={map[s] ?? ""}>
        {s}
      </Badge>
      {row.expiring_soon && s !== "Expired" && (
        <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {row.days_to_expiry != null ? `Renews in ${row.days_to_expiry}d` : "Expiring soon"}
        </span>
      )}
    </div>
  )
}

async function apiSend(url: string, method: string, body?: any) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || "Request failed")
  return data
}

// ── Summary cards ────────────────────────────────────────────────────────────

function SummaryCards({ s }: { s: Summary }) {
  const cards = [
    { label: "Active Subscriptions", value: s.active + s.trial, icon: LayoutGrid, hint: `${s.trial} on trial` },
    { label: "Monthly Spend", value: inr(s.monthly_spend), icon: Wallet, hint: `${inr(s.annual_spend)} / year` },
    { label: "Seats Used", value: `${s.seats_used} / ${s.seats_total}`, icon: Users, hint: "across all subscriptions" },
    { label: "Expiring Soon", value: s.expiring_soon, icon: CalendarClock, hint: `${s.expired} expired`, alert: s.expiring_soon > 0 },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="flex items-start justify-between gap-2 p-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{c.label}</p>
              <p className="mt-1 truncate text-xl font-semibold tabular-nums">{c.value}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{c.hint}</p>
            </div>
            <span
              className={`rounded-md p-2 ${c.alert ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}
            >
              <c.icon className="h-4 w-4" />
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Create / Edit form ──────────────────────────────────────────────────────

const emptyForm = {
  service_name: "",
  category: "Software / SaaS",
  vendor_party_id: "",
  plan_name: "",
  description: "",
  billing_cycle: "Monthly",
  currency: "INR",
  amount: "",
  seats_total: "0",
  auto_renew: true,
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  trial_end_date: "",
  payment_method: "",
  account_email: "",
  department: "",
  status: "Active",
  reminder_days: "14",
  notes: "",
}

function SubscriptionForm({
  open,
  onOpenChange,
  editing,
  lookups,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: SubscriptionRow | null
  lookups: Lookups | undefined
  onSaved: () => void
}) {
  const [form, setForm] = useState<any>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [initId, setInitId] = useState<string | null>(null)

  // Sync form to the row being edited (or reset for a new record) whenever the
  // dialog target changes.
  const targetId = editing?.subscription_id ?? "__new__"
  if (open && initId !== targetId) {
    setInitId(targetId)
    setForm(
      editing
        ? {
            service_name: editing.service_name,
            category: editing.category ?? "Software / SaaS",
            vendor_party_id: editing.vendor_party_id ?? "",
            plan_name: editing.plan_name ?? "",
            description: editing.description ?? "",
            billing_cycle: editing.billing_cycle,
            currency: editing.currency,
            amount: String(editing.amount ?? ""),
            seats_total: String(editing.seats_total ?? 0),
            auto_renew: editing.auto_renew,
            start_date: editing.start_date ?? "",
            end_date: editing.end_date ?? "",
            trial_end_date: editing.trial_end_date ?? "",
            payment_method: editing.payment_method ?? "",
            account_email: editing.account_email ?? "",
            department: editing.department ?? "",
            status: editing.status,
            reminder_days: String(editing.reminder_days ?? 14),
            notes: editing.notes ?? "",
          }
        : emptyForm,
    )
  }

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.service_name.trim()) {
      toast.error("Service name is required.")
      return
    }
    setSaving(true)
    try {
      const vendor = lookups?.vendors.find((v) => v.party_id === form.vendor_party_id)
      const payload = {
        ...form,
        amount: Number(form.amount || 0),
        seats_total: Number(form.seats_total || 0),
        reminder_days: Number(form.reminder_days || 0),
        vendor_party_id: form.vendor_party_id || null,
        vendor_name: vendor?.name ?? null,
        department: form.department || null,
        end_date: form.end_date || null,
        trial_end_date: form.trial_end_date || null,
      }
      if (editing) {
        await apiSend(`/api/assets/company-subscriptions/${editing.subscription_id}`, "PATCH", {
          action: "update",
          ...payload,
        })
        toast.success("Subscription updated.")
      } else {
        await apiSend(`/api/assets/company-subscriptions`, "POST", payload)
        toast.success("Subscription created.")
      }
      onOpenChange(false)
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Subscription" : "New Subscription"}</DialogTitle>
          <DialogDescription>
            Track a recurring SaaS tool, license or service. Vendors come from the Finance customers/vendors master.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="service_name">Service / Tool name *</Label>
            <Input id="service_name" value={form.service_name} onChange={(e) => set("service_name", e.target.value)} placeholder="e.g. Figma, AWS, Microsoft 365" />
          </div>

          <div>
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => set("category", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Vendor</Label>
            <Select value={form.vendor_party_id || "none"} onValueChange={(v) => set("vendor_party_id", v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No vendor</SelectItem>
                {lookups?.vendors.map((v) => <SelectItem key={v.party_id} value={v.party_id}>{v.name || v.party_id}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="plan_name">Plan</Label>
            <Input id="plan_name" value={form.plan_name} onChange={(e) => set("plan_name", e.target.value)} placeholder="e.g. Business, Pro" />
          </div>

          <div>
            <Label>Billing cycle</Label>
            <Select value={form.billing_cycle} onValueChange={(v) => set("billing_cycle", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {BILLING_CYCLES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="amount">Amount per cycle ({form.currency})</Label>
            <Input id="amount" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
          </div>

          <div>
            <Label htmlFor="seats_total">Licensed seats</Label>
            <Input id="seats_total" type="number" min="0" value={form.seats_total} onChange={(e) => set("seats_total", e.target.value)} />
          </div>

          <div>
            <Label htmlFor="start_date">Start date</Label>
            <Input id="start_date" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
          </div>

          <div>
            <Label htmlFor="end_date">Renewal / expiry date</Label>
            <Input id="end_date" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} />
          </div>

          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {form.status === "Trial" && (
            <div>
              <Label htmlFor="trial_end_date">Trial end date</Label>
              <Input id="trial_end_date" type="date" value={form.trial_end_date} onChange={(e) => set("trial_end_date", e.target.value)} />
            </div>
          )}

          <div>
            <Label>Owner department</Label>
            <Select value={form.department || "none"} onValueChange={(v) => set("department", v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unspecified</SelectItem>
                {lookups?.departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="payment_method">Payment method</Label>
            <Input id="payment_method" value={form.payment_method} onChange={(e) => set("payment_method", e.target.value)} placeholder="e.g. Corporate card" />
          </div>

          <div>
            <Label htmlFor="account_email">Account email</Label>
            <Input id="account_email" type="email" value={form.account_email} onChange={(e) => set("account_email", e.target.value)} />
          </div>

          <div>
            <Label htmlFor="reminder_days">Reminder lead (days)</Label>
            <Input id="reminder_days" type="number" min="0" value={form.reminder_days} onChange={(e) => set("reminder_days", e.target.value)} />
          </div>

          <div className="flex items-center gap-2 pt-6">
            <Switch id="auto_renew" checked={form.auto_renew} onCheckedChange={(v) => set("auto_renew", v)} />
            <Label htmlFor="auto_renew">Auto-renew</Label>
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Create subscription"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Detail sheet ────────────────────────────────────────────────────────────

function DetailSheet({
  subscriptionId,
  onOpenChange,
  lookups,
  onChanged,
}: {
  subscriptionId: string | null
  onOpenChange: (v: boolean) => void
  lookups: Lookups | undefined
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<Detail>(
    subscriptionId ? `/api/assets/company-subscriptions/${subscriptionId}` : null,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const [seatEmp, setSeatEmp] = useState("")

  const sub = data?.subscription

  async function act(url: string, method: string, body?: any, okMsg?: string) {
    setBusy(true)
    try {
      await apiSend(url, method, body)
      if (okMsg) toast.success(okMsg)
      await mutate()
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const base = `/api/assets/company-subscriptions/${subscriptionId}`

  return (
    <Sheet open={!!subscriptionId} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {sub && (
          <SheetHeader className="border-b p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle className="truncate">{sub.service_name}</SheetTitle>
                <SheetDescription className="truncate">
                  {sub.subscription_id} · {sub.vendor_name || "No vendor"} · {sub.plan_name || sub.category || "—"}
                </SheetDescription>
              </div>
              {statusBadge(sub)}
            </div>
          </SheetHeader>
        )}

        {isLoading && <p className="p-5 text-sm text-muted-foreground">Loading…</p>}

        {sub && (
          <div className="flex-1 space-y-5 p-5">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Info label="Amount" value={`${inr(sub.amount)} / ${sub.billing_cycle}`} />
              <Info label="Monthly cost" value={inr(sub.monthly_cost)} />
              <Info label="Start" value={fmtDate(sub.start_date)} />
              <Info label="Renewal / expiry" value={fmtDate(sub.end_date)} />
              <Info label="Seats" value={`${sub.seats_used} used / ${sub.seats_total}`} />
              <Info label="Auto-renew" value={sub.auto_renew ? "Yes" : "No"} />
              <Info label="Department" value={sub.department || "—"} />
              <Info label="Payment" value={sub.payment_method || "—"} />
            </div>

            {/* Lifecycle actions */}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(base, "PATCH", { action: "renew" }, "Subscription renewed.")}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Renew
              </Button>
              {sub.status !== "Suspended" && sub.status !== "Cancelled" && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act(base, "PATCH", { action: "suspend" }, "Subscription suspended.")}>
                  Suspend
                </Button>
              )}
              {(sub.status === "Suspended" || sub.status === "Expired") && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act(base, "PATCH", { action: "reactivate" }, "Subscription reactivated.")}>
                  Reactivate
                </Button>
              )}
              {sub.status !== "Cancelled" && (
                <Button size="sm" variant="outline" className="text-red-600" disabled={busy} onClick={() => act(base, "PATCH", { action: "cancel" }, "Subscription cancelled.")}>
                  Cancel
                </Button>
              )}
            </div>

            <Separator />

            <Tabs defaultValue="seats">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="seats">Seats</TabsTrigger>
                <TabsTrigger value="renewals">Renewals</TabsTrigger>
                <TabsTrigger value="docs">Docs</TabsTrigger>
                <TabsTrigger value="audit">Activity</TabsTrigger>
              </TabsList>

              {/* Seats */}
              <TabsContent value="seats" className="space-y-3 pt-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Label className="text-xs">Assign seat to employee</Label>
                    <Select value={seatEmp} onValueChange={setSeatEmp}>
                      <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                      <SelectContent>
                        {lookups?.employees.map((e) => (
                          <SelectItem key={e.id} value={String(e.id)}>
                            {e.employee_name || `Employee ${e.id}`}{e.department ? ` · ${e.department}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    disabled={busy || !seatEmp || sub.seats_available <= 0}
                    onClick={async () => {
                      await act(`${base}/seats`, "POST", { employee_id: Number(seatEmp) }, "Seat assigned.")
                      setSeatEmp("")
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Assign
                  </Button>
                </div>
                {sub.seats_available <= 0 && sub.seats_total > 0 && (
                  <p className="text-xs text-amber-600">All {sub.seats_total} seat(s) are assigned. Revoke a seat or increase the licence count.</p>
                )}

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead>Assigned</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(data?.seats ?? []).length === 0 && (
                        <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">No seats assigned yet.</TableCell></TableRow>
                      )}
                      {data?.seats.map((s) => (
                        <TableRow key={s.seat_id}>
                          <TableCell>
                            <div className="font-medium">{s.employee_name || `#${s.employee_id}`}</div>
                            <div className="text-xs text-muted-foreground">{s.department || "—"}</div>
                          </TableCell>
                          <TableCell className="text-sm">{fmtDate(s.assigned_date)}</TableCell>
                          <TableCell>
                            <Badge variant={s.status === "Active" ? "secondary" : "outline"} className={s.status === "Active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : ""}>
                              {s.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {s.status === "Active" && (
                              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy}
                                onClick={() => act(`${base}/seats`, "PATCH", { seat_id: s.seat_id }, "Seat revoked.")}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              {/* Renewals */}
              <TabsContent value="renewals" className="space-y-2 pt-3">
                {(data?.renewals ?? []).length === 0 && <p className="text-sm text-muted-foreground">No renewal history.</p>}
                {data?.renewals.map((r, i) => (
                  <div key={i} className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{r.action}</span>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(r.created_at)}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {r.previous_end_date && <>Until {fmtDate(r.previous_end_date)} → {fmtDate(r.new_end_date)} · </>}
                      {r.amount != null && <>{inr(r.amount)} · </>}
                      {r.performed_by_name || "System"}
                    </div>
                    {r.remarks && <div className="mt-1 text-xs">{r.remarks}</div>}
                  </div>
                ))}
              </TabsContent>

              {/* Docs */}
              <TabsContent value="docs" className="space-y-2 pt-3">
                {(data?.documents ?? []).length === 0 && <p className="text-sm text-muted-foreground">No documents attached.</p>}
                {data?.documents.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                    <a href={d.file_url} target="_blank" rel="noreferrer" className="truncate font-medium text-primary hover:underline">
                      {d.label || d.file_name || "Document"}
                    </a>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy}
                      onClick={() => act(`${base}/documents?doc_id=${d.id}`, "DELETE", undefined, "Document removed.")}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </TabsContent>

              {/* Audit */}
              <TabsContent value="audit" className="space-y-2 pt-3">
                {(data?.audit ?? []).length === 0 && <p className="text-sm text-muted-foreground">No activity yet.</p>}
                {data?.audit.map((a, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 rounded-md border p-2.5 text-sm">
                    <div>
                      <span className="font-medium capitalize">{a.action.replace(/_/g, " ")}</span>
                      {a.reason && <span className="text-muted-foreground"> — {a.reason}</span>}
                      <div className="text-xs text-muted-foreground">{a.user_name || "System"}</div>
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(a.created_at)}</span>
                  </div>
                ))}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  )
}

// ── Analytics panel ───────────────────────────────────────────────────────────

function AnalyticsPanel() {
  const { data } = useSWR<Analytics>("/api/assets/company-subscriptions/analytics", fetcher)
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading analytics…</p>
  const groups: [string, Analytics["by_category"]][] = [
    ["By category", data.by_category],
    ["By vendor", data.by_vendor],
    ["By department", data.by_department],
  ]
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        {groups.map(([title, rows]) => (
          <Card key={title}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {rows.length === 0 && <p className="text-sm text-muted-foreground">No live spend.</p>}
              {rows.slice(0, 6).map((r) => (
                <div key={r.label} className="flex items-center justify-between text-sm">
                  <span className="truncate pr-2">{r.label}</span>
                  <span className="whitespace-nowrap font-medium tabular-nums">{inr(r.monthly)}/mo</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarClock className="h-4 w-4" /> Upcoming renewals (next 60 days)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.upcoming_renewals.length === 0 && <p className="text-sm text-muted-foreground">Nothing due soon.</p>}
          <div className="space-y-2">
            {data.upcoming_renewals.map((u) => (
              <div key={u.subscription_id} className="flex items-center justify-between rounded-md border p-2.5 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{u.service_name}</div>
                  <div className="text-xs text-muted-foreground">{u.vendor_name || "—"} · {inr(u.amount)}</div>
                </div>
                <div className="text-right">
                  <div className="font-medium">{fmtDate(u.end_date)}</div>
                  <div className={`text-xs ${(u.days_to_expiry ?? 99) < 0 ? "text-red-600" : "text-amber-600"}`}>
                    {u.days_to_expiry != null ? (u.days_to_expiry < 0 ? `${Math.abs(u.days_to_expiry)}d overdue` : `in ${u.days_to_expiry}d`) : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Main client ───────────────────────────────────────────────────────────────

export function CompanySubscriptionsClient() {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [category, setCategory] = useState("all")
  const [cycle, setCycle] = useState("all")
  const [expiringOnly, setExpiringOnly] = useState(false)
  const [sort, setSort] = useState("created_at")
  const [dir, setDir] = useState<"asc" | "desc">("desc")

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SubscriptionRow | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const listKey = useMemo(() => {
    const p = new URLSearchParams()
    if (search) p.set("search", search)
    if (status !== "all") p.set("status", status)
    if (category !== "all") p.set("category", category)
    if (cycle !== "all") p.set("billing_cycle", cycle)
    if (expiringOnly) p.set("expiring", "1")
    p.set("sort", sort)
    p.set("dir", dir)
    return `/api/assets/company-subscriptions?${p.toString()}`
  }, [search, status, category, cycle, expiringOnly, sort, dir])

  const { data, isLoading, mutate } = useSWR<ListResponse>(listKey, fetcher)
  const { data: lookups } = useSWR<Lookups>("/api/assets/company-subscriptions/lookups", fetcher)

  const rows = data?.rows ?? []
  const summary = data?.summary

  function toggleSort(col: string) {
    if (sort === col) setDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSort(col)
      setDir("asc")
    }
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <CreditCard className="h-6 w-6" /> Company Subscriptions
          </h1>
          <p className="text-sm text-muted-foreground">SaaS tools, licenses and recurring services — cost, seats and renewals.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/assets/company-subscriptions/export?${listKey.split("?")[1] ?? ""}`}>
              <Download className="mr-1.5 h-4 w-4" /> Export
            </a>
          </Button>
          <Button onClick={() => { setEditing(null); setFormOpen(true) }}>
            <Plus className="mr-1.5 h-4 w-4" /> New Subscription
          </Button>
        </div>
      </div>

      {summary && <SummaryCards s={summary} />}

      <Tabs defaultValue="register">
        <TabsList>
          <TabsTrigger value="register">Register</TabsTrigger>
          <TabsTrigger value="analytics">Cost Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="space-y-4 pt-4">
          {/* Filters */}
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search service, vendor, plan or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full lg:w-36"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full lg:w-44"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={cycle} onValueChange={setCycle}>
              <SelectTrigger className="w-full lg:w-36"><SelectValue placeholder="Cycle" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All cycles</SelectItem>
                {BILLING_CYCLES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant={expiringOnly ? "default" : "outline"} onClick={() => setExpiringOnly((v) => !v)} className="whitespace-nowrap">
              <AlertTriangle className="mr-1.5 h-4 w-4" /> Expiring
            </Button>
          </div>

          {/* Table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("service_name")}>Service</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("amount")}>Cost</TableHead>
                  <TableHead>Seats</TableHead>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("end_date")}>Renewal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
                )}
                {!isLoading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No subscriptions found. Create your first one.</TableCell></TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.subscription_id} className="cursor-pointer" onClick={() => setDetailId(r.subscription_id)}>
                    <TableCell>
                      <div className="font-medium">{r.service_name}</div>
                      <div className="text-xs text-muted-foreground">{r.plan_name || r.category || r.subscription_id}</div>
                    </TableCell>
                    <TableCell className="text-sm">{r.vendor_name || "—"}</TableCell>
                    <TableCell>
                      <div className="font-medium tabular-nums">{inr(r.amount)}</div>
                      <div className="text-xs text-muted-foreground">{r.billing_cycle}</div>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{r.seats_used}/{r.seats_total}</TableCell>
                    <TableCell className="text-sm">{fmtDate(r.end_date)}</TableCell>
                    <TableCell>{statusBadge(r)}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setFormOpen(true) }}>Edit</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="pt-4">
          <AnalyticsPanel />
        </TabsContent>
      </Tabs>

      <SubscriptionForm open={formOpen} onOpenChange={setFormOpen} editing={editing} lookups={lookups} onSaved={() => mutate()} />
      <DetailSheet subscriptionId={detailId} onOpenChange={(v) => !v && setDetailId(null)} lookups={lookups} onChanged={() => mutate()} />
    </div>
  )
}
