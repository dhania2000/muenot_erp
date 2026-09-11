"use client"

import type React from "react"
import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { LeaveTypeDetail } from "@/components/hr/leave-type-detail"

const EMPTY = {
  id: undefined as number | undefined,
  leave_code: "",
  leave_type: "",
  annual_quota: "",
  accrual_method: "Annual",
  prorate_on_join: true,
  carry_forward: "",
  allow_negative: false,
  low_balance_threshold: "",
  min_days_per_request: "",
  max_days_per_request: "",
  max_consecutive_days: "",
  max_requests_per_year: "",
  advance_notice_days: "",
  allow_half_day: false,
  allow_backdated: false,
  backdated_limit_days: "",
  count_weekends: false,
  count_holidays: false,
  requires_document: false,
  paid: true,
  applicable_gender: "",
  applicable_employment_type: "",
  effective_from: "",
  effective_until: "",
  status: "Active",
  description: "",
}

const ANY = "__any__"
type SortKey = "leave_type" | "leave_type_id" | "annual_quota" | "carry_forward" | "status"

function BoolField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} />
      {label}
    </label>
  )
}

export function LeaveTypesClient() {
  const { data, mutate } = useSWR<{ leaveTypes: any[] }>("/api/hr/leave-types", fetcher)
  const [form, setForm] = useState<any>(EMPTY)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [paidFilter, setPaidFilter] = useState("all")
  const [sortKey, setSortKey] = useState<SortKey>("status")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [detailId, setDetailId] = useState<string | null>(null)

  const change = (key: string, value: any) => setForm((current: any) => ({ ...current, [key]: value }))

  const rows = useMemo(() => {
    let list = data?.leaveTypes ?? []
    const term = search.trim().toLowerCase()
    if (term) {
      list = list.filter((r) =>
        `${r.leave_type_id} ${r.leave_code ?? ""} ${r.leave_type} ${r.description ?? ""}`
          .toLowerCase()
          .includes(term),
      )
    }
    if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter)
    if (paidFilter !== "all") list = list.filter((r) => (paidFilter === "paid" ? r.paid : !r.paid))

    const sorted = [...list].sort((a, b) => {
      if (sortKey === "annual_quota" || sortKey === "carry_forward") {
        return Number(a[sortKey]) - Number(b[sortKey])
      }
      return String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""))
    })
    if (sortDir === "desc") sorted.reverse()
    return sorted
  }, [data, search, statusFilter, paidFilter, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  function openCreate() {
    setForm(EMPTY)
    setError(null)
    setOpen(true)
  }

  function openEdit(row: any) {
    setForm({
      ...EMPTY,
      ...row,
      applicable_gender: row.applicable_gender ?? "",
      applicable_employment_type: row.applicable_employment_type ?? "",
      effective_from: row.effective_from ? String(row.effective_from).slice(0, 10) : "",
      effective_until: row.effective_until ? String(row.effective_until).slice(0, 10) : "",
      prorate_on_join: !!row.prorate_on_join,
      allow_negative: !!row.allow_negative,
      allow_half_day: !!row.allow_half_day,
      allow_backdated: !!row.allow_backdated,
      count_weekends: !!row.count_weekends,
      count_holidays: !!row.count_holidays,
      requires_document: !!row.requires_document,
      paid: !!row.paid,
    })
    setError(null)
    setOpen(true)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const res = await fetch("/api/hr/leave-types", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(payload?.error ?? "Unable to save leave type")
        return
      }
      setOpen(false)
      setForm(EMPTY)
      mutate()
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(row: any) {
    await fetch("/api/hr/leave-types", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, status: row.status === "Active" ? "Inactive" : "Active" }),
    })
    mutate()
  }

  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-sm text-muted-foreground">HR policy configuration</p>
        <h1 className="text-3xl font-semibold">Leave Types</h1>
        <p className="text-muted-foreground">
          Define quotas, carry-forward rules, eligibility, documentation, and paid leave policies.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-64"
            placeholder="Search by ID, code, or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="Active">Active</SelectItem>
              <SelectItem value="Inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <Select value={paidFilter} onValueChange={(v) => setPaidFilter(v ?? "all")}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Pay" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All pay</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="unpaid">Unpaid</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton moduleKey="hr-leave-types" onImported={mutate} />
          <ExcelExportButton
            rows={rows}
            filename="leave-types"
            columns={[
              { header: "Leave Type ID", value: (r: any) => r.leave_type_id },
              { header: "Code", value: (r: any) => r.leave_code },
              { header: "Leave Type", value: (r: any) => r.leave_type },
              { header: "Annual Quota", value: (r: any) => r.annual_quota },
              { header: "Carry Forward", value: (r: any) => r.carry_forward },
              { header: "Max Consecutive Days", value: (r: any) => r.max_consecutive_days },
              { header: "Requires Document", value: (r: any) => r.requires_document },
              { header: "Paid", value: (r: any) => r.paid },
              { header: "Accrual Method", value: (r: any) => r.accrual_method },
              { header: "Status", value: (r: any) => r.status },
            ]}
          />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button onClick={openCreate} />}>Add leave type</DialogTrigger>
            <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{form.id ? "Edit leave type" : "Add leave type"}</DialogTitle>
              </DialogHeader>
              <form onSubmit={save} className="space-y-6">
                {error ? (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
                ) : null}

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Basic details</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-1">
                      <Label>Leave Type name</Label>
                      <Input required value={form.leave_type} onChange={(e) => change("leave_type", e.target.value)} />
                    </div>
                    <div>
                      <Label>Leave Code</Label>
                      <Input
                        placeholder="CL, SL, EL…"
                        value={form.leave_code}
                        maxLength={20}
                        onChange={(e) => change("leave_code", e.target.value.toUpperCase())}
                      />
                    </div>
                    {form.id ? (
                      <div>
                        <Label>Leave Type ID</Label>
                        <Input value={form.leave_type_id ?? ""} disabled />
                      </div>
                    ) : null}
                    <div className="sm:col-span-2">
                      <Label>Description</Label>
                      <Textarea
                        rows={2}
                        value={form.description ?? ""}
                        onChange={(e) => change("description", e.target.value)}
                      />
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Entitlement & accrual</h3>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <Label>Annual quota</Label>
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={form.annual_quota}
                        onChange={(e) => change("annual_quota", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Accrual method</Label>
                      <Select value={form.accrual_method} onValueChange={(v) => change("accrual_method", v)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Annual">Annual</SelectItem>
                          <SelectItem value="Monthly">Monthly</SelectItem>
                          <SelectItem value="Quarterly">Quarterly</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Carry forward (max)</Label>
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={form.carry_forward}
                        onChange={(e) => change("carry_forward", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Low balance alert</Label>
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={form.low_balance_threshold}
                        onChange={(e) => change("low_balance_threshold", e.target.value)}
                      />
                    </div>
                    <div className="flex items-end gap-4 sm:col-span-2">
                      <BoolField
                        id="prorate_on_join"
                        label="Prorate on join"
                        checked={form.prorate_on_join}
                        onChange={(v) => change("prorate_on_join", v)}
                      />
                      <BoolField
                        id="allow_negative"
                        label="Allow negative balance"
                        checked={form.allow_negative}
                        onChange={(v) => change("allow_negative", v)}
                      />
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Request rules</h3>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <Label>Min days / request</Label>
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={form.min_days_per_request}
                        onChange={(e) => change("min_days_per_request", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Max days / request</Label>
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={form.max_days_per_request}
                        onChange={(e) => change("max_days_per_request", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Max consecutive days</Label>
                      <Input
                        type="number"
                        min="0"
                        value={form.max_consecutive_days}
                        onChange={(e) => change("max_consecutive_days", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Max requests / year</Label>
                      <Input
                        type="number"
                        min="0"
                        value={form.max_requests_per_year}
                        onChange={(e) => change("max_requests_per_year", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Advance notice (days)</Label>
                      <Input
                        type="number"
                        min="0"
                        value={form.advance_notice_days}
                        onChange={(e) => change("advance_notice_days", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Backdated limit (days)</Label>
                      <Input
                        type="number"
                        min="0"
                        value={form.backdated_limit_days}
                        onChange={(e) => change("backdated_limit_days", e.target.value)}
                        disabled={!form.allow_backdated}
                      />
                    </div>
                    <div className="flex items-center gap-4 sm:col-span-3">
                      <BoolField
                        id="allow_half_day"
                        label="Allow half-day"
                        checked={form.allow_half_day}
                        onChange={(v) => change("allow_half_day", v)}
                      />
                      <BoolField
                        id="allow_backdated"
                        label="Allow backdated"
                        checked={form.allow_backdated}
                        onChange={(v) => change("allow_backdated", v)}
                      />
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Day counting, pay & documents</h3>
                  <div className="flex flex-wrap items-center gap-4">
                    <BoolField
                      id="count_weekends"
                      label="Count weekends"
                      checked={form.count_weekends}
                      onChange={(v) => change("count_weekends", v)}
                    />
                    <BoolField
                      id="count_holidays"
                      label="Count holidays"
                      checked={form.count_holidays}
                      onChange={(v) => change("count_holidays", v)}
                    />
                    <BoolField id="paid" label="Paid leave" checked={form.paid} onChange={(v) => change("paid", v)} />
                    <BoolField
                      id="requires_document"
                      label="Requires document"
                      checked={form.requires_document}
                      onChange={(v) => change("requires_document", v)}
                    />
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Eligibility & validity</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label>Applicable gender</Label>
                      <Select
                        value={form.applicable_gender || ANY}
                        onValueChange={(v) => change("applicable_gender", v === ANY ? "" : v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ANY}>Any</SelectItem>
                          <SelectItem value="Male">Male</SelectItem>
                          <SelectItem value="Female">Female</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Employment type</Label>
                      <Select
                        value={form.applicable_employment_type || ANY}
                        onValueChange={(v) => change("applicable_employment_type", v === ANY ? "" : v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ANY}>Any</SelectItem>
                          <SelectItem value="Full-time">Full-time</SelectItem>
                          <SelectItem value="Part-time">Part-time</SelectItem>
                          <SelectItem value="Contract">Contract</SelectItem>
                          <SelectItem value="Intern">Intern</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Effective from</Label>
                      <Input
                        type="date"
                        value={form.effective_from}
                        onChange={(e) => change("effective_from", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Effective until</Label>
                      <Input
                        type="date"
                        value={form.effective_until}
                        onChange={(e) => change("effective_until", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Status</Label>
                      <Select value={form.status} onValueChange={(v) => change("status", v)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Active">Active</SelectItem>
                          <SelectItem value="Inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </section>

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? "Saving…" : form.id ? "Save changes" : "Create leave type"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="cursor-pointer" onClick={() => toggleSort("leave_type_id")}>
                ID
              </TableHead>
              <TableHead className="cursor-pointer" onClick={() => toggleSort("leave_type")}>
                Leave Type
              </TableHead>
              <TableHead>Code</TableHead>
              <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("annual_quota")}>
                Annual Quota
              </TableHead>
              <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("carry_forward")}>
                Carry Fwd
              </TableHead>
              <TableHead className="text-right">Max Days</TableHead>
              <TableHead>Paid</TableHead>
              <TableHead>Document</TableHead>
              <TableHead className="cursor-pointer" onClick={() => toggleSort("status")}>
                Status
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                  No leave types found.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.leave_type_id}</TableCell>
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setDetailId(row.leave_type_id)}
                    >
                      {row.leave_type}
                    </button>
                  </TableCell>
                  <TableCell>{row.leave_code ? <Badge variant="secondary">{row.leave_code}</Badge> : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.annual_quota}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.carry_forward}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.max_consecutive_days || "—"}</TableCell>
                  <TableCell>{row.paid ? "Paid" : "Unpaid"}</TableCell>
                  <TableCell>{row.requires_document ? "Required" : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={row.status === "Active" ? "default" : "outline"}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setDetailId(row.leave_type_id)}>
                        View
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => toggleStatus(row)}>
                        {row.status === "Active" ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <LeaveTypeDetail leaveTypeId={detailId} open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)} />
    </main>
  )
}
