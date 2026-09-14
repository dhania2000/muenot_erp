"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Plus, FilterX, Pencil, Eye, Trash2, Upload, FileDown, Send, Loader2Icon,
  Receipt, Coins, Wallet, Clock, Landmark, FileText, Users, TrendingUp,
  Banknote, BookOpen, CreditCard, ArrowLeftRight, Check, X,
} from "lucide-react"
import { Field, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { DialogFooter } from "@/components/ui/dialog"
import { inr, inr0 } from "@/lib/finance-calc"
import { FINANCE_MODULE_CONFIGS } from "@/lib/finance-module-configs"
import { ExcelExportButton } from "@/components/excel-export-button"
import { FinanceModuleDialog } from "@/components/finance/finance-module-dialog"
import { FinanceImportDialog } from "@/components/finance/finance-import-dialog"
import { ImportButton } from "@/components/import-button"
import type { BadgeVariant, ModuleConfig, TableColumn } from "@/lib/finance-schema"

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Receipt, Coins, Wallet, Clock, Landmark, FileText, Users, TrendingUp,
  Banknote, BookOpen, CreditCard, ArrowLeftRight,
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

type Row = Record<string, any>

// Two-stage invoice approval workflow (Freelance + FTE). Mirrors the labels in
// lib/finance-invoice-workflow.ts. Rows carry a per-user `__caps` object from
// the server that decides what the current viewer may do with each row.
const WORKFLOW_MODULE_KEYS = new Set(["freelance-invoices", "fte-invoices"])

const WF = {
  PENDING_EMPLOYEE: "Pending Employee Approval",
  PENDING_MANAGER: "Pending Manager Approval",
  READY: "Ready for Disbursement",
  REJECTED_EMPLOYEE: "Rejected by Employee",
  REJECTED_MANAGER: "Rejected by Manager",
}

type RowCaps = {
  relation: "full" | "assignee" | "manager" | "none"
  canView: boolean
  canDownload: boolean
  canEmployeeAct: boolean
  canManagerAct: boolean
}

function rowCaps(row: Row): RowCaps | null {
  return (row.__caps as RowCaps) ?? null
}

function workflowBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case WF.READY:
      return "default"
    case WF.REJECTED_EMPLOYEE:
    case WF.REJECTED_MANAGER:
      return "destructive"
    case WF.PENDING_MANAGER:
      return "secondary"
    default:
      return "outline"
  }
}

/** Human label for the approval badge. Rejections name who rejected it. */
function workflowLabel(row: Row): string {
  const status = row.workflow_status || WF.PENDING_EMPLOYEE
  if (status === WF.REJECTED_EMPLOYEE) return `Invoice Rejected By ${row.workflow_rejected_by || "Employee"}`
  if (status === WF.REJECTED_MANAGER) return `Invoice Rejected By ${row.workflow_rejected_by || "Manager"}`
  return status
}

/** Mask all but the last 4 characters of a sensitive identifier (account no.). */
function maskValue(raw: any): string {
  const s = String(raw).replace(/\s+/g, "")
  if (s.length <= 4) return s
  return `${"•".repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`
}

function cellValue(col: TableColumn, row: Row) {
  const raw = row[col.key]
  if (col.money) return inr(raw)
  if (raw === null || raw === undefined || raw === "") return "—"
  if (col.mask) return maskValue(raw)
  return String(raw)
}

export function FinanceModuleClient({ moduleKey }: { moduleKey: string }) {
  const cfg = FINANCE_MODULE_CONFIGS[moduleKey]
  if (!cfg) return <div className="p-6 text-sm text-muted-foreground">Unknown finance module.</div>
  return <ModuleView cfg={cfg} />
}

function ModuleView({ cfg }: { cfg: ModuleConfig }) {
  const selectFilters = useMemo(
    () => (cfg.filters ?? []).filter((f): f is Extract<typeof f, { type: "select" }> => f.type === "select"),
    [cfg.filters],
  )
  const rangeFilters = useMemo(
    () => (cfg.filters ?? []).filter((f): f is Extract<typeof f, { type: "number_range" }> => f.type === "number_range"),
    [cfg.filters],
  )
  const emptyFilters = useMemo(() => {
    const base: Record<string, string> = { search: "", financial_year: "", month: "", date_from: "", date_to: "" }
    for (const f of selectFilters) base[f.key] = ""
    for (const f of rangeFilters) {
      base[f.keyMin] = ""
      base[f.keyMax] = ""
    }
    // Seed the search / financial-year filters from the URL query so deep links
    // (e.g. "open this account in the General Ledger") land pre-filtered. Read
    // once, on the client only, so it never fights the user's later edits.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search)
      const search = params.get("search")
      const fy = params.get("financial_year")
      if (search) base.search = search
      if (fy) base.financial_year = fy
    }
    return base
  }, [selectFilters, rangeFilters])
  const [filters, setFilters] = useState(emptyFilters)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [viewing, setViewing] = useState<Row | null>(null)
  const [sending, setSending] = useState<Row | null>(null)
  const [rejecting, setRejecting] = useState<{ row: Row; kind: "employee" | "manager" } | null>(null)
  const [actingId, setActingId] = useState<number | null>(null)

  const isWorkflow = WORKFLOW_MODULE_KEYS.has(cfg.key)

  const queryKey = useMemo(() => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
    return `/api/finance/module/${cfg.key}?${params.toString()}`
  }, [cfg.key, filters])

  const { data, mutate } = useSWR<{ rows: Row[]; summary: any; filterOptions: any }>(queryKey, fetcher)

  const rows = data?.rows ?? []
  const summary = data?.summary ?? {}
  const financialYears: string[] = data?.filterOptions?.financialYears ?? []
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const hasDate = !!cfg.dateColumn
  const hasFY = !!cfg.financialYearColumn

  function openNew() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(row: Row) {
    setEditing(row)
    setDialogOpen(true)
  }
  async function remove(row: Row) {
    if (!confirm(`Delete ${row[cfg.idColumn]}? This cannot be undone.`)) return
    await fetch(`/api/finance/module/${cfg.key}?id=${row.id}`, { method: "DELETE" })
    mutate()
  }

  async function approve(row: Row, kind: "employee" | "manager") {
    setActingId(row.id)
    try {
      const res = await fetch(`/api/finance/module/${cfg.key}/workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, action: kind === "employee" ? "employee_approve" : "manager_approve" }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        alert(json.error || "Could not approve the invoice.")
        return
      }
      mutate()
    } finally {
      setActingId(null)
    }
  }

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{cfg.subtitle}</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">{cfg.label}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExcelExportButton
            rows={rows}
            filename={cfg.key}
            columns={cfg.tableColumns.map((col) => ({
              header: col.label,
              value: (row: Row) => row[col.key],
            }))}
          />
          {cfg.importSpec && (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload data-icon="inline-start" />
              Import statement
            </Button>
          )}
          <ImportButton moduleKey={`finance-${cfg.key}`} onImported={() => mutate()} />
          <Button onClick={openNew}>
            <Plus data-icon="inline-start" />
            {cfg.addLabel}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cfg.kpis.map((k) => {
          const Icon = (k.icon && ICONS[k.icon]) || FileText
          const value = summary[k.key]
          return (
            <Card key={k.label}>
              <CardContent className="flex flex-col gap-2 pt-6">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <span className="text-xl font-semibold tracking-tight">
                  {k.money ? inr0(value) : (value ?? 0)}
                </span>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            placeholder="Search..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="lg:col-span-2"
          />
          {hasFY && (
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Financial year"
              value={filters.financial_year}
              onChange={(e) => setFilters((f) => ({ ...f, financial_year: e.target.value }))}
            >
              <option value="">All financial years</option>
              {financialYears.map((fy) => <option key={fy} value={fy}>{fy}</option>)}
            </select>
          )}
          {hasDate && (
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Month"
              value={filters.month}
              onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}
            >
              <option value="">All months</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          )}
          {hasDate && (
            <div className="flex items-center gap-2">
              <Input type="date" aria-label="From date" value={filters.date_from} onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value }))} />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" aria-label="To date" value={filters.date_to} onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value }))} />
            </div>
          )}
          {selectFilters.map((f) => (
            <select
              key={f.key}
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label={f.label}
              value={filters[f.key] ?? ""}
              onChange={(e) => setFilters((prev) => ({ ...prev, [f.key]: e.target.value }))}
            >
              <option value="">All {f.label.toLowerCase()}</option>
              {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ))}
          {rangeFilters.map((f) => (
            <div key={f.keyMin} className="flex items-center gap-2">
              <Input
                type="number"
                className="w-32"
                aria-label={`${f.label} minimum`}
                placeholder={`Min ${f.label.toLowerCase()}`}
                value={filters[f.keyMin] ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, [f.keyMin]: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="number"
                className="w-32"
                aria-label={`${f.label} maximum`}
                placeholder={`Max ${f.label.toLowerCase()}`}
                value={filters[f.keyMax] ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, [f.keyMax]: e.target.value }))}
              />
            </div>
          ))}
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setFilters(emptyFilters)}>
              <FilterX data-icon="inline-start" />
              Clear filters ({activeFilterCount})
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">{cfg.label}</span>
            <Badge variant="secondary">{rows.length} records</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {cfg.tableColumns.map((col) => (
                    <th key={col.key} className={`p-2 font-medium ${col.align === "right" ? "text-right" : ""}`}>
                      {col.label}
                    </th>
                  ))}
                  {isWorkflow && <th className="p-2 font-medium">Approval</th>}
                  <th className="p-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={cfg.tableColumns.length + (isWorkflow ? 2 : 1)} className="p-6 text-center text-muted-foreground">
                      No records match the current filters.
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id} className="border-b hover:bg-muted/40">
                    {cfg.tableColumns.map((col) => (
                      <td key={col.key} className={`p-2 ${col.align === "right" ? "text-right" : ""} ${col.mono ? "font-mono text-xs" : ""}`}>
                        <TableCellContent col={col} row={row} />
                      </td>
                    ))}
                    {isWorkflow && (
                      <td className="p-2">
                        <Badge variant={workflowBadgeVariant(row.workflow_status || WF.PENDING_EMPLOYEE)}>
                          {workflowLabel(row)}
                        </Badge>
                        {(row.workflow_status === WF.REJECTED_EMPLOYEE || row.workflow_status === WF.REJECTED_MANAGER) &&
                          row.workflow_rejection_reason && (
                            <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                              {row.workflow_rejection_reason}
                            </div>
                          )}
                      </td>
                    )}
                    <td className="p-2">
                      <div className="flex items-center justify-end gap-1">
                        {isWorkflow && rowCaps(row)?.canEmployeeAct && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Approve as employee"
                              disabled={actingId === row.id}
                              onClick={() => approve(row, "employee")}
                            >
                              {actingId === row.id ? <Loader2Icon className="size-4 animate-spin" /> : <Check className="size-4 text-emerald-600" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Reject as employee"
                              disabled={actingId === row.id}
                              onClick={() => setRejecting({ row, kind: "employee" })}
                            >
                              <X className="size-4 text-destructive" />
                            </Button>
                          </>
                        )}
                        {isWorkflow && rowCaps(row)?.canManagerAct && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Approve as manager"
                              disabled={actingId === row.id}
                              onClick={() => approve(row, "manager")}
                            >
                              {actingId === row.id ? <Loader2Icon className="size-4 animate-spin" /> : <Check className="size-4 text-emerald-600" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Reject as manager"
                              disabled={actingId === row.id}
                              onClick={() => setRejecting({ row, kind: "manager" })}
                            >
                              <X className="size-4 text-destructive" />
                            </Button>
                          </>
                        )}
                        {cfg.pdfPath && (!isWorkflow || rowCaps(row)?.canDownload) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Download PDF"
                            render={
                              <a
                                href={`${cfg.pdfPath}/${row.id}/pdf?download=1`}
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            }
                          >
                            <FileDown className="size-4" />
                          </Button>
                        )}
                        {cfg.invoiceActions && (
                          <Button variant="ghost" size="icon" aria-label="Send by email" onClick={() => setSending(row)}>
                            <Send className="size-4" />
                          </Button>
                        )}
                        {cfg.detailPath ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Open detail view"
                            render={<a href={`${cfg.detailPath}/${encodeURIComponent(row[cfg.idColumn])}`} />}
                          >
                            <Eye className="size-4" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="icon" aria-label="View" onClick={() => setViewing(row)}>
                            <Eye className="size-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(row)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => remove(row)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <FinanceModuleDialog
        cfg={cfg}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        record={editing}
        onSaved={() => {
          setDialogOpen(false)
          mutate()
        }}
      />

      {cfg.importSpec && (
        <FinanceImportDialog
          cfg={cfg}
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={() => mutate()}
        />
      )}

      <DetailDialog cfg={cfg} row={viewing} onClose={() => setViewing(null)} />

      {isWorkflow && (
        <RejectInvoiceDialog
          cfg={cfg}
          target={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={() => {
            setRejecting(null)
            mutate()
          }}
        />
      )}

      {cfg.invoiceActions && (
        <SendInvoiceDialog
          cfg={cfg}
          row={sending}
          onClose={() => setSending(null)}
          onSent={() => {
            setSending(null)
            mutate()
          }}
        />
      )}
    </main>
  )
}

function TableCellContent({ col, row }: { col: TableColumn; row: Row }) {
  if (col.badge) {
    const value = row[col.key]
    const variant: BadgeVariant = (value && col.badge[value]) || "outline"
    return value ? <Badge variant={variant}>{value}</Badge> : <span className="text-muted-foreground">—</span>
  }
  const main = cellValue(col, row)
  const sub = col.sub ? row[col.sub] : null
  if (sub) {
    return (
      <div>
        <div className="font-medium">{main}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
    )
  }
  return <>{main}</>
}

function SendInvoiceDialog({
  cfg,
  row,
  onClose,
  onSent,
}: {
  cfg: ModuleConfig
  row: Row | null
  onClose: () => void
  onSent: () => void
}) {
  const [to, setTo] = useState("")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRowId, setLastRowId] = useState<number | null>(null)

  // Reset the form whenever a different row is opened.
  if (row && row.id !== lastRowId) {
    setLastRowId(row.id)
    setTo((cfg.emailField && row[cfg.emailField]) || "")
    setSubject("")
    setMessage("")
    setError(null)
    setBusy(false)
  }

  async function submit() {
    if (!row) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${cfg.pdfPath}/${row.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), subject: subject.trim(), message: message.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || "Failed to send the invoice.")
        return
      }
      onSent()
    } catch {
      setError("Network error while sending the invoice.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {row && (
          <>
            <DialogHeader>
              <DialogTitle>Send invoice by email</DialogTitle>
              <DialogDescription>
                Emails <span className="font-mono">{row[cfg.idColumn]}</span> with the PDF attached.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="send-to">Recipient email</FieldLabel>
                <Input
                  id="send-to"
                  type="email"
                  placeholder="freelancer@example.com"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="send-subject">Subject</FieldLabel>
                <Input
                  id="send-subject"
                  placeholder="Leave blank for the default subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="send-message">Message</FieldLabel>
                <Textarea
                  id="send-message"
                  rows={4}
                  placeholder="Leave blank for the default message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy || !to.trim()}>
                {busy ? <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
                {busy ? "Sending..." : "Send invoice"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RejectInvoiceDialog({
  cfg,
  target,
  onClose,
  onRejected,
}: {
  cfg: ModuleConfig
  target: { row: Row; kind: "employee" | "manager" } | null
  onClose: () => void
  onRejected: () => void
}) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRowId, setLastRowId] = useState<number | null>(null)

  // Reset the form whenever a different invoice is opened.
  if (target && target.row.id !== lastRowId) {
    setLastRowId(target.row.id)
    setReason("")
    setError(null)
    setBusy(false)
  }

  async function submit() {
    if (!target) return
    if (!reason.trim()) {
      setError("A rejection reason is required.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/finance/module/${cfg.key}/workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: target.row.id,
          action: target.kind === "employee" ? "employee_reject" : "manager_reject",
          reason: reason.trim(),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || "Failed to reject the invoice.")
        return
      }
      onRejected()
    } catch {
      setError("Network error while rejecting the invoice.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {target && (
          <>
            <DialogHeader>
              <DialogTitle>Reject invoice</DialogTitle>
              <DialogDescription>
                Rejecting <span className="font-mono">{target.row[cfg.idColumn]}</span> as{" "}
                {target.kind === "employee" ? "employee" : "manager"}. Provide a reason.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="reject-reason">Rejection reason</FieldLabel>
                <Textarea
                  id="reject-reason"
                  rows={4}
                  placeholder="Explain why this invoice is being rejected"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={submit} disabled={busy || !reason.trim()}>
                {busy ? <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" /> : <X data-icon="inline-start" />}
                {busy ? "Rejecting..." : "Reject invoice"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailDialog({ cfg, row, onClose }: { cfg: ModuleConfig; row: Row | null; onClose: () => void }) {
  const sections = useMemo(() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const f of cfg.fields) {
      if (!seen.has(f.section)) {
        seen.add(f.section)
        order.push(f.section)
      }
    }
    return order
  }, [cfg])

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        {row && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{row[cfg.idColumn]}</DialogTitle>
              <DialogDescription>
                {cfg.label} · created by {row.created_by_name || "—"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 py-2 text-sm">
              {sections.map((section) => {
                const fields = cfg.fields.filter((f) => f.section === section)
                return (
                  <div key={section}>
                    <h3 className="mb-2 text-sm font-semibold">{section}</h3>
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                      {fields.map((f) => {
                        let value = row[f.key]
                        if (f.type === "checkbox") value = value ? "Yes" : "No"
                        else if (f.money) value = inr(value)
                        return (
                          <div key={f.key} className="flex justify-between gap-4 border-b border-dashed py-1">
                            <dt className="text-muted-foreground">{f.label}</dt>
                            <dd className="text-right font-medium">
                              {value === null || value === undefined || value === "" ? "—" : String(value)}
                            </dd>
                          </div>
                        )
                      })}
                    </dl>
                  </div>
                )
              })}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Record history</h3>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  <div className="flex justify-between gap-4 border-b border-dashed py-1">
                    <dt className="text-muted-foreground">Created at</dt>
                    <dd className="text-right font-medium">{row.created_at || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-dashed py-1">
                    <dt className="text-muted-foreground">Last updated</dt>
                    <dd className="text-right font-medium">{row.updated_at || "—"}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
