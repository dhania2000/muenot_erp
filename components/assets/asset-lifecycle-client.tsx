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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, ShieldCheck, Wrench } from "lucide-react"

type AssetOption = { asset_id: string; asset_name: string | null; asset_category: string | null; status: string | null }
type Lookups = {
  assets: AssetOption[]
  warranty_types: string[]
  maintenance_types: string[]
  maintenance_statuses: string[]
}
type WarrantyRow = {
  warranty_id: string
  finance_fixed_asset_id: string
  asset_name: string | null
  provider: string
  warranty_type: string
  start_date: string | null
  expiry_date: string
  reference_no: string | null
  cost: number
  reminder_days: number
}
type MaintenanceRow = {
  maintenance_id: string
  finance_fixed_asset_id: string
  asset_name: string | null
  maintenance_type: string
  status: string
  scheduled_date: string | null
  performed_date: string | null
  vendor_name: string | null
  cost: number
  description: string
  next_service_date: string | null
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())
const fmtDate = (v: string | null) => (v ? v.slice(0, 10) : "—")
const fmtMoney = (v: number | null) =>
  v == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v)

const today = () => new Date().toISOString().slice(0, 10)

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso.slice(0, 10))
  if (!Number.isFinite(t)) return null
  return Math.round((t - Date.parse(today())) / 86_400_000)
}

function ExpiryBadge({ date }: { date: string | null }) {
  const d = daysUntil(date)
  if (d == null) return <span className="text-muted-foreground">—</span>
  if (d < 0)
    return <Badge variant="secondary" className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">Expired</Badge>
  if (d <= 30)
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        {d}d left
      </Badge>
    )
  return <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Valid</Badge>
}

const MAINT_STATUS_STYLES: Record<string, string> = {
  Scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  "In Progress": "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  Completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Cancelled: "bg-muted text-muted-foreground",
}

export function AssetLifecycleClient() {
  const { data: lookups } = useSWR<Lookups>("/api/assets/asset-lifecycle/lookups", fetcher)
  const { data: warrantyData, mutate: mutateWarranty } = useSWR<{ rows: WarrantyRow[] }>(
    "/api/assets/asset-lifecycle/warranties",
    fetcher,
  )
  const { data: maintenanceData, mutate: mutateMaintenance } = useSWR<{ rows: MaintenanceRow[] }>(
    "/api/assets/asset-lifecycle/maintenance",
    fetcher,
  )

  const [warrantyOpen, setWarrantyOpen] = useState(false)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const assets = lookups?.assets ?? []
  const warranties = warrantyData?.rows ?? []
  const maintenance = maintenanceData?.rows ?? []

  const expiringSoon = useMemo(
    () => warranties.filter((w) => { const d = daysUntil(w.expiry_date); return d != null && d >= 0 && d <= 30 }).length,
    [warranties],
  )
  const expired = useMemo(
    () => warranties.filter((w) => { const d = daysUntil(w.expiry_date); return d != null && d < 0 }).length,
    [warranties],
  )
  const openMaintenance = useMemo(
    () => maintenance.filter((m) => m.status === "Scheduled" || m.status === "In Progress").length,
    [maintenance],
  )

  const [wForm, setWForm] = useState({
    finance_fixed_asset_id: "",
    provider: "",
    warranty_type: "Manufacturer",
    start_date: "",
    expiry_date: "",
    reference_no: "",
    cost: "",
    reminder_days: "30",
    coverage: "",
  })

  const [mForm, setMForm] = useState({
    finance_fixed_asset_id: "",
    maintenance_type: "Corrective",
    status: "Scheduled",
    scheduled_date: "",
    performed_date: "",
    vendor_name: "",
    cost: "",
    description: "",
    next_service_date: "",
    reminder_days: "15",
  })

  async function submitWarranty() {
    setSaving(true)
    try {
      const res = await fetch("/api/assets/asset-lifecycle/warranties", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wForm),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? "Failed to save warranty.")
      toast.success("Warranty recorded")
      setWarrantyOpen(false)
      setWForm({ finance_fixed_asset_id: "", provider: "", warranty_type: "Manufacturer", start_date: "", expiry_date: "", reference_no: "", cost: "", reminder_days: "30", coverage: "" })
      mutateWarranty()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function submitMaintenance() {
    setSaving(true)
    try {
      const res = await fetch("/api/assets/asset-lifecycle/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Idempotency key guards against double-submit posting a duplicate cost.
        body: JSON.stringify({ ...mForm, idempotency_key: `mnt-${mForm.finance_fixed_asset_id}-${mForm.scheduled_date || mForm.performed_date}-${mForm.description}`.slice(0, 80) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? "Failed to log maintenance.")
      toast.success(body?.idempotent ? "Maintenance already logged" : "Maintenance logged")
      setMaintenanceOpen(false)
      setMForm({ finance_fixed_asset_id: "", maintenance_type: "Corrective", status: "Scheduled", scheduled_date: "", performed_date: "", vendor_name: "", cost: "", description: "", next_service_date: "", reminder_days: "15" })
      mutateMaintenance()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const assetLabel = (a: AssetOption) => `${a.asset_id}${a.asset_name ? ` — ${a.asset_name}` : ""}`

  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Asset Warranty &amp; Maintenance</h1>
        <p className="text-sm text-muted-foreground">
          Track warranty coverage, service history and upcoming maintenance for company fixed assets. Expiry reminders
          flow through the shared Document Expiry alerts.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground">Warranties</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{warranties.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground">Expiring ≤30d</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold text-amber-600">{expiringSoon}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground">Expired</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold text-red-600">{expired}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground">Open Maintenance</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{openMaintenance}</CardContent>
        </Card>
      </section>

      <Tabs defaultValue="warranties" className="w-full">
        <TabsList>
          <TabsTrigger value="warranties" className="gap-2"><ShieldCheck className="h-4 w-4" />Warranties</TabsTrigger>
          <TabsTrigger value="maintenance" className="gap-2"><Wrench className="h-4 w-4" />Maintenance</TabsTrigger>
        </TabsList>

        <TabsContent value="warranties" className="mt-4">
          <div className="mb-3 flex justify-end">
            <Button size="sm" onClick={() => setWarrantyOpen(true)} className="gap-2"><Plus className="h-4 w-4" />Add warranty</Button>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {warranties.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No warranties recorded yet.</TableCell></TableRow>
                  ) : (
                    warranties.map((w) => (
                      <TableRow key={w.warranty_id}>
                        <TableCell className="font-medium">{w.asset_name || w.finance_fixed_asset_id}</TableCell>
                        <TableCell>{w.provider}</TableCell>
                        <TableCell><Badge variant="outline">{w.warranty_type}</Badge></TableCell>
                        <TableCell>{fmtDate(w.expiry_date)}</TableCell>
                        <TableCell><ExpiryBadge date={w.expiry_date} /></TableCell>
                        <TableCell className="text-right">{fmtMoney(w.cost)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="maintenance" className="mt-4">
          <div className="mb-3 flex justify-end">
            <Button size="sm" onClick={() => setMaintenanceOpen(true)} className="gap-2"><Plus className="h-4 w-4" />Log maintenance</Button>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Performed</TableHead>
                    <TableHead>Next service</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {maintenance.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No maintenance records yet.</TableCell></TableRow>
                  ) : (
                    maintenance.map((m) => (
                      <TableRow key={m.maintenance_id}>
                        <TableCell className="font-medium">{m.asset_name || m.finance_fixed_asset_id}</TableCell>
                        <TableCell><Badge variant="outline">{m.maintenance_type}</Badge></TableCell>
                        <TableCell><Badge variant="secondary" className={MAINT_STATUS_STYLES[m.status] ?? ""}>{m.status}</Badge></TableCell>
                        <TableCell>{fmtDate(m.performed_date)}</TableCell>
                        <TableCell>{fmtDate(m.next_service_date)}</TableCell>
                        <TableCell className="text-right">{fmtMoney(m.cost)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add warranty dialog */}
      <Dialog open={warrantyOpen} onOpenChange={setWarrantyOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add warranty</DialogTitle>
            <DialogDescription>Record warranty coverage for a company fixed asset.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>Asset</Label>
              <Select value={wForm.finance_fixed_asset_id} onValueChange={(v) => setWForm((f) => ({ ...f, finance_fixed_asset_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select fixed asset" /></SelectTrigger>
                <SelectContent>
                  {assets.map((a) => (<SelectItem key={a.asset_id} value={a.asset_id}>{assetLabel(a)}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Provider</Label>
                <Input value={wForm.provider} onChange={(e) => setWForm((f) => ({ ...f, provider: e.target.value }))} placeholder="e.g. Dell, HP" />
              </div>
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={wForm.warranty_type} onValueChange={(v) => setWForm((f) => ({ ...f, warranty_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(lookups?.warranty_types ?? []).map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Start date</Label>
                <Input type="date" value={wForm.start_date} onChange={(e) => setWForm((f) => ({ ...f, start_date: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label>Expiry date</Label>
                <Input type="date" value={wForm.expiry_date} onChange={(e) => setWForm((f) => ({ ...f, expiry_date: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-2">
                <Label>Reference no.</Label>
                <Input value={wForm.reference_no} onChange={(e) => setWForm((f) => ({ ...f, reference_no: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label>Cost</Label>
                <Input type="number" min={0} value={wForm.cost} onChange={(e) => setWForm((f) => ({ ...f, cost: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label>Remind (days)</Label>
                <Input type="number" min={0} value={wForm.reminder_days} onChange={(e) => setWForm((f) => ({ ...f, reminder_days: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Coverage / notes</Label>
              <Textarea value={wForm.coverage} onChange={(e) => setWForm((f) => ({ ...f, coverage: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWarrantyOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submitWarranty} disabled={saving}>Save warranty</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log maintenance dialog */}
      <Dialog open={maintenanceOpen} onOpenChange={setMaintenanceOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Log maintenance</DialogTitle>
            <DialogDescription>Record a service, repair or scheduled maintenance event.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>Asset</Label>
              <Select value={mForm.finance_fixed_asset_id} onValueChange={(v) => setMForm((f) => ({ ...f, finance_fixed_asset_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select fixed asset" /></SelectTrigger>
                <SelectContent>
                  {assets.map((a) => (<SelectItem key={a.asset_id} value={a.asset_id}>{assetLabel(a)}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={mForm.maintenance_type} onValueChange={(v) => setMForm((f) => ({ ...f, maintenance_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(lookups?.maintenance_types ?? []).map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select value={mForm.status} onValueChange={(v) => setMForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(lookups?.maintenance_statuses ?? []).map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Scheduled date</Label>
                <Input type="date" value={mForm.scheduled_date} onChange={(e) => setMForm((f) => ({ ...f, scheduled_date: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label>Performed date</Label>
                <Input type="date" value={mForm.performed_date} onChange={(e) => setMForm((f) => ({ ...f, performed_date: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Next service date</Label>
                <Input type="date" value={mForm.next_service_date} onChange={(e) => setMForm((f) => ({ ...f, next_service_date: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label>Remind (days)</Label>
                <Input type="number" min={0} value={mForm.reminder_days} onChange={(e) => setMForm((f) => ({ ...f, reminder_days: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Vendor</Label>
                <Input value={mForm.vendor_name} onChange={(e) => setMForm((f) => ({ ...f, vendor_name: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label>Cost</Label>
                <Input type="number" min={0} value={mForm.cost} onChange={(e) => setMForm((f) => ({ ...f, cost: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Description</Label>
              <Textarea value={mForm.description} onChange={(e) => setMForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="What was done / needs doing" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMaintenanceOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submitMaintenance} disabled={saving}>Save record</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
