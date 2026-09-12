"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Award, Download, Mail, Plus, Pencil, Ban, ArrowUpDown, Search, Eye, PlayCircle } from "lucide-react"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { DocumentTypesManager } from "@/components/hr/document-types-manager"
import { LookupSelect } from "@/components/hr/master-data/lookup-select"
import { MASTER_META, formatCell, type FieldDef, type MasterMeta } from "@/components/hr/master-data/field-config"
import { MasterSummaryPanel } from "@/components/hr/master-data/summary-panel"

const TAB_ORDER = [
  "departments",
  "designations",
  "document-types",
  "promotions",
  "awards",
  "appreciations",
  "passport-visa",
  "holidays",
] as const
type Kind = (typeof TAB_ORDER)[number]

const IMPORT_KIND: Partial<Record<Kind, string>> = {
  departments: "hr-departments",
  designations: "hr-designations",
  holidays: "hr-holidays",
}
const CERT_KINDS = new Set<Kind>(["awards", "appreciations"])

type MailTarget = { kind: Kind; id: number; name: string; title: string; email: string }

export function MasterDataClient({ initialKind = "departments" }: { initialKind?: Kind }) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const isDocTypes = kind === "document-types"
  const meta: MasterMeta | undefined = MASTER_META[kind]

  const { data, mutate, isLoading } = useSWR<any>(isDocTypes ? null : `/api/hr/master-data?kind=${kind}`, fetcher)
  const rows: any[] = data?.rows || []

  // ---- table controls ----
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [sortKey, setSortKey] = useState<string>("")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const columns = useMemo(
    () => (meta ? meta.fields.filter((f) => f.column !== false) : []),
    [meta],
  )

  const visibleRows = useMemo(() => {
    if (!meta) return []
    let out = rows
    const q = search.trim().toLowerCase()
    if (q) {
      out = out.filter((r) =>
        meta.searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q)),
      )
    }
    if (meta.hasStatus && statusFilter !== "all") {
      out = out.filter((r) => String(r.status || "") === statusFilter)
    }
    if (sortKey) {
      out = [...out].sort((a, b) => {
        const av = a[sortKey] ?? ""
        const bv = b[sortKey] ?? ""
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
        return sortDir === "asc" ? cmp : -cmp
      })
    }
    return out
  }, [rows, meta, search, statusFilter, sortKey, sortDir])

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  // ---- detail view ----
  const [detailRow, setDetailRow] = useState<any | null>(null)

  // ---- apply due promotions job ----
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState<string | null>(null)
  async function applyDuePromotions() {
    setApplying(true)
    setApplyMsg(null)
    try {
      const res = await fetch("/api/hr/master-data/promotions/apply", { method: "POST" })
      const json = await res.json()
      if (!res.ok) {
        setApplyMsg(json.error || "Could not apply promotions.")
      } else {
        const applied = json.applied?.length ?? 0
        const skipped = json.skipped?.length ?? 0
        setApplyMsg(
          applied === 0 && skipped === 0
            ? "No promotions were due to take effect."
            : `Applied ${applied} promotion${applied === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.`,
        )
        mutate()
      }
    } catch {
      setApplyMsg("Could not apply promotions.")
    } finally {
      setApplying(false)
    }
  }

  // ---- form dialog ----
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [form, setForm] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function openCreate() {
    setEditing(null)
    setForm({ status: "Active" })
    setFormError(null)
    setFormOpen(true)
  }

  function openEdit(row: any) {
    setEditing(row)
    const init: Record<string, any> = {}
    for (const f of meta!.fields) {
      if (f.displayOnly) continue
      const v = row[f.name]
      init[f.name] = f.type === "date" && v ? String(v).slice(0, 10) : v ?? ""
    }
    setForm(init)
    setFormError(null)
    setFormOpen(true)
  }

  // When picking an employee for a promotion, auto-fill the "old" context.
  async function onEmployeePicked(employeeId: string | null) {
    setForm((f) => ({ ...f, employee_id: employeeId }))
    if (kind !== "promotions" || !employeeId) return
    try {
      const res = await fetch(`/api/hr/master-data/lookups?kind=employee-context&employeeId=${employeeId}`)
      const json = await res.json()
      if (res.ok && json.employee) {
        setForm((f) => ({
          ...f,
          old_department_id: json.employee.old_department_id ?? "",
          old_designation_id: json.employee.old_designation_id ?? "",
          old_grade: json.employee.grade ?? "",
        }))
      }
    } catch {
      /* non-fatal: auto-fill is a convenience */
    }
  }

  async function save() {
    if (!meta) return
    setSaving(true)
    setFormError(null)
    try {
      const payload: Record<string, any> = { kind }
      for (const f of meta.fields) {
        if (f.displayOnly) continue
        if (editing && f.editable === false) continue
        if (f.name in form) payload[f.name] = form[f.name]
      }
      if (editing) payload.id = editing[meta.idKey]
      const res = await fetch("/api/hr/master-data", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(json.error || "Save failed.")
        return
      }
      setFormOpen(false)
      mutate()
    } finally {
      setSaving(false)
    }
  }

  // ---- deactivate / delete ----
  const [confirmRow, setConfirmRow] = useState<any | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function confirmDeactivate() {
    if (!meta || !confirmRow) return
    setDeleting(true)
    try {
      await fetch(`/api/hr/master-data?kind=${kind}&id=${encodeURIComponent(confirmRow[meta.idKey])}`, {
        method: "DELETE",
      })
      setConfirmRow(null)
      mutate()
    } finally {
      setDeleting(false)
    }
  }

  // ---- certificate email (awards / appreciations) ----
  const showCert = CERT_KINDS.has(kind)
  const [mail, setMail] = useState<MailTarget | null>(null)
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [to, setTo] = useState("")
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  function openMail(row: any) {
    const label = kind === "awards" ? "Certificate of Excellence" : "Certificate of Appreciation"
    const title = kind === "awards" ? row.award_name : row.title
    const name = row.employee_name || `Employee #${row.employee_id}`
    setMail({ kind, id: row[meta!.idKey], name, title, email: row.employee_email || "" })
    setTo(row.employee_email || "")
    setSubject(`${label} — ${title}`)
    setMessage(
      `Dear ${name},\n\nPlease find attached your ${label.toLowerCase()} for "${title}". Congratulations and thank you for your contribution.`,
    )
    setFeedback(null)
  }

  async function sendMail() {
    if (!mail) return
    setSending(true)
    setFeedback(null)
    try {
      const res = await fetch("/api/hr/master-data/certificate/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: mail.kind, id: mail.id, to, subject, message }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) setFeedback(json.error || "Failed to send email.")
      else setMail(null)
    } finally {
      setSending(false)
    }
  }

  function certUrl(row: any, download = false) {
    return `/api/hr/master-data/certificate?kind=${kind}&id=${row[meta!.idKey]}${download ? "&download=1" : ""}`
  }

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">HR Master Data</h1>
        <p className="text-muted-foreground">
          Manage departments, designations, recognition, travel documents and holidays.
        </p>
      </div>

      <MasterSummaryPanel
        onJump={(k) => {
          setKind(k as Kind)
          setSearch("")
          setStatusFilter("all")
          setSortKey("")
        }}
      />

      <div className="flex flex-wrap gap-2">
        {TAB_ORDER.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={key === kind ? "default" : "outline"}
            onClick={() => {
              setKind(key)
              setSearch("")
              setStatusFilter("all")
              setSortKey("")
            }}
          >
            {key === "document-types" ? "Document Types" : MASTER_META[key]?.label}
          </Button>
        ))}
      </div>

      {isDocTypes && <DocumentTypesManager />}

      {!isDocTypes && meta && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${meta.label.toLowerCase()}…`}
                  className="h-9 w-56 pl-8"
                />
              </div>
              {meta.hasStatus && (
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
                  <SelectTrigger className="h-9 w-36">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Inactive">Inactive</SelectItem>
                    <SelectItem value="Pending">Pending</SelectItem>
                    <SelectItem value="Approved">Approved</SelectItem>
                    <SelectItem value="Rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-2">
              {kind === "promotions" && (
                <Button size="sm" variant="outline" onClick={applyDuePromotions} disabled={applying}>
                  <PlayCircle className="mr-1 size-4" />
                  {applying ? "Applying…" : "Apply due promotions"}
                </Button>
              )}
              {IMPORT_KIND[kind] && <ImportButton moduleKey={IMPORT_KIND[kind]!} onImported={mutate} />}
              <ExcelExportButton
                rows={visibleRows}
                filename={kind}
                columns={columns.map((f) => ({ header: f.label, value: (r: any) => formatCell(f, r[f.name]) }))}
              />
              <Button size="sm" onClick={openCreate}>
                <Plus className="mr-1 size-4" />
                New {meta.singular}
              </Button>
            </div>
          </div>

          {applyMsg && kind === "promotions" && (
            <p className="text-sm text-muted-foreground" role="status">
              {applyMsg}
            </p>
          )}

          {showCert && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Award className="size-4" />
              Generate a certificate PDF or email it to the employee from each row.
            </p>
          )}

          <section className="overflow-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  {columns.map((f) => (
                    <th key={f.name} className="whitespace-nowrap p-3 text-left font-medium">
                      <button
                        type="button"
                        onClick={() => toggleSort(f.name)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {f.label}
                        <ArrowUpDown className="size-3 opacity-50" />
                      </button>
                    </th>
                  ))}
                  <th className="whitespace-nowrap p-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={columns.length + 1} className="p-6 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="p-6 text-center text-muted-foreground">
                      No {meta.label.toLowerCase()} found.
                    </td>
                  </tr>
                )}
                {visibleRows.map((row, i) => (
                  <tr className="border-t hover:bg-muted/20" key={row[meta.idKey] ?? i}>
                    {columns.map((f) => (
                      <td className="whitespace-nowrap p-3" key={f.name}>
                        {f.name === "status" ? (
                          <Badge variant={statusVariant(row.status)}>{row.status || "—"}</Badge>
                        ) : f.name === "expiry_status" ? (
                          row.expiry_status ? (
                            <Badge variant={expiryVariant(row.expiry_status)}>{row.expiry_status}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )
                        ) : (
                          formatCell(f, row[f.name])
                        )}
                      </td>
                    ))}
                    <td className="whitespace-nowrap p-3">
                      <div className="flex items-center justify-end gap-2">
                        {showCert && (
                          <>
                            <a
                              href={certUrl(row)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium hover:bg-accent"
                            >
                              <Download className="mr-1 size-3.5" />
                              PDF
                            </a>
                            <Button size="sm" variant="outline" onClick={() => openMail(row)}>
                              <Mail className="mr-1 size-3.5" />
                              Email
                            </Button>
                          </>
                        )}
                        <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailRow(row)}>
                          <Eye className="size-3.5" />
                          <span className="sr-only">View details</span>
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8" onClick={() => openEdit(row)}>
                          <Pencil className="size-3.5" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        {row.status !== "Inactive" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 text-destructive"
                            onClick={() => setConfirmRow(row)}
                          >
                            <Ban className="size-3.5" />
                            <span className="sr-only">Deactivate</span>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {/* Create / Edit form */}
      <Dialog open={formOpen} onOpenChange={(o) => !o && setFormOpen(false)}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${meta?.singular}` : `New ${meta?.singular}`}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this record. IDs and codes are managed automatically."
                : "The ID / code is generated automatically on save."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            {meta?.fields
              .filter((f) => !f.displayOnly && !(editing && f.editable === false))
              .map((f) => (
                <FieldInput
                  key={f.name}
                  field={f}
                  value={form[f.name]}
                  onChange={(v) => setForm((prev) => ({ ...prev, [f.name]: v }))}
                  onEmployeePicked={onEmployeePicked}
                />
              ))}
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : `Create ${meta?.singular}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail view */}
      <Dialog open={!!detailRow} onOpenChange={(o) => !o && setDetailRow(null)}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{meta?.singular} details</DialogTitle>
            <DialogDescription>Read-only view of the full record.</DialogDescription>
          </DialogHeader>
          {detailRow && meta && (
            <dl className="grid gap-x-6 gap-y-3 py-2 sm:grid-cols-2">
              {meta.fields.map((f) => {
                const raw = detailRow[f.name]
                return (
                  <div key={f.name} className="space-y-0.5">
                    <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
                    <dd className="text-sm">
                      {f.name === "status" ? (
                        <Badge variant={statusVariant(detailRow.status)}>{detailRow.status || "—"}</Badge>
                      ) : f.name === "expiry_status" ? (
                        raw ? (
                          <Badge variant={expiryVariant(raw)}>{raw}</Badge>
                        ) : (
                          "—"
                        )
                      ) : (
                        formatCell(f, raw) || "—"
                      )}
                    </dd>
                  </div>
                )
              })}
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRow(null)}>
              Close
            </Button>
            {detailRow && (
              <Button
                onClick={() => {
                  const r = detailRow
                  setDetailRow(null)
                  openEdit(r)
                }}
              >
                Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate confirmation */}
      <AlertDialog open={!!confirmRow} onOpenChange={(o) => !o && setConfirmRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this record?</AlertDialogTitle>
            <AlertDialogDescription>
              Records that other data depends on are archived (set to Inactive) rather than deleted, so history stays
              intact. Unused records are removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeactivate} disabled={deleting}>
              {deleting ? "Working…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Certificate email */}
      <Dialog open={!!mail} onOpenChange={(o) => !o && setMail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Email certificate</DialogTitle>
            <DialogDescription>
              {mail ? `Send the certificate PDF for "${mail.title}" to ${mail.name}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cert-to">To</Label>
              <Input
                id="cert-to"
                type="email"
                placeholder="recipient@company.com"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-subject">Subject</Label>
              <Input id="cert-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-message">Message</Label>
              <Textarea id="cert-message" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>
            {feedback && <p className="text-sm text-destructive">{feedback}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMail(null)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={sendMail} disabled={sending || !to.trim()}>
              {sending ? "Sending…" : "Send certificate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function statusVariant(status?: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "Active":
    case "Approved":
      return "default"
    case "Inactive":
    case "Rejected":
      return "destructive"
  case "Pending":
  return "secondary"
  default:
  return "outline"
  }
  }

function expiryVariant(status?: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "Expired":
      return "destructive"
    case "Expiring soon":
      return "secondary"
    case "Valid":
      return "default"
    default:
      return "outline"
  }
}

function FieldInput({
  field,
  value,
  onChange,
  onEmployeePicked,
}: {
  field: FieldDef
  value: any
  onChange: (v: any) => void
  onEmployeePicked: (employeeId: string | null) => void
}) {
  const wide = field.wide || field.type === "textarea"
  return (
    <div className={wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>
      {field.type === "textarea" && (
        <Textarea rows={3} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.type === "select" && (
        <Select value={value || ""} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {field.type === "checkbox" && (
        <div className="flex h-9 items-center">
          <Checkbox checked={!!value} onCheckedChange={(c) => onChange(!!c)} />
        </div>
      )}
      {field.type === "lookup" && (
        <LookupSelect
          kind={field.lookup!}
          value={value ? String(value) : null}
          onChange={(v) => (field.lookup === "employees" ? onEmployeePicked(v) : onChange(v))}
        />
      )}
      {(field.type === "text" || field.type === "date" || field.type === "number" || field.type === "currency") && (
        <Input
          type={field.type === "date" ? "date" : field.type === "text" ? "text" : "number"}
          step={field.type === "currency" ? "0.01" : undefined}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
