"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { ExcelExportButton } from "@/components/excel-export-button"
import {
  FileCheck2,
  Upload,
  Eye,
  Download,
  Check,
  X,
  RefreshCw,
  Archive,
  ArchiveRestore,
  Trash2,
  Search,
  ShieldCheck,
  Clock,
  AlertTriangle,
  CircleSlash,
} from "lucide-react"

type DocType = { id: number; type_name: string; is_required: 0 | 1; has_expiry: 0 | 1; expiry_warn_days: number }
type Doc = Record<string, any>
type ApiResponse = {
  documents: Doc[]
  documentTypes: DocType[]
  summary: {
    total: number
    verified: number
    pending: number
    rejected: number
    expiringSoon: number
    expired: number
    missingRequired: number
  }
  checklist: { type: string; required: boolean; uploaded: boolean; verified: boolean }[] | null
  scope: "all" | "self"
  selfEmployeeId: number | null
  canUpload: boolean
  canManage: boolean
  canDelete: boolean
}

const STATUS_STYLES: Record<string, string> = {
  Verified: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  Pending: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  "Pending Verification": "border-amber-500/40 bg-amber-500/10 text-amber-400",
  Rejected: "border-red-500/40 bg-red-500/10 text-red-400",
}
const EXPIRY_STYLES: Record<string, string> = {
  Valid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  "Expiring Soon": "border-amber-500/40 bg-amber-500/10 text-amber-400",
  Expired: "border-red-500/40 bg-red-500/10 text-red-400",
}

export function EmployeeDocumentsClient() {
  // Filters
  const [q, setQ] = useState("")
  const [fEmployee, setFEmployee] = useState("")
  const [fDept, setFDept] = useState("")
  const [fDesignation, setFDesignation] = useState("")
  const [fType, setFType] = useState("")
  const [fStatus, setFStatus] = useState("")
  const [fExpiry, setFExpiry] = useState("")
  const [view, setView] = useState<"active" | "archived">("active")
  const [uploadedFrom, setUploadedFrom] = useState("")
  const [uploadedTo, setUploadedTo] = useState("")

  const listKey = useMemo(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set("q", q.trim())
    if (fEmployee) p.set("employee_id", fEmployee)
    if (fDept) p.set("department", fDept)
    if (fDesignation) p.set("designation", fDesignation)
    if (fType) p.set("document_type", fType)
    if (fStatus) p.set("status", fStatus)
    if (fExpiry) p.set("expiry", fExpiry)
    if (uploadedFrom) p.set("uploaded_from", uploadedFrom)
    if (uploadedTo) p.set("uploaded_to", uploadedTo)
    p.set("view", view)
    return `/api/hr/employee-documents?${p.toString()}`
  }, [q, fEmployee, fDept, fDesignation, fType, fStatus, fExpiry, uploadedFrom, uploadedTo, view])

  const { data, isLoading, mutate } = useSWR<ApiResponse>(listKey, fetcher)
  const isSelf = data?.scope === "self"
  const canManage = !!data?.canManage
  const canDelete = !!data?.canDelete
  const canUpload = data?.canUpload ?? true

  const { data: employeeData } = useSWR<{ employees: any[] }>(isSelf ? null : "/api/hr/employees", fetcher)
  const employees = employeeData?.employees || []
  const documentTypes = data?.documentTypes || []
  const departments = useMemo(
    () => Array.from(new Set(employees.map((e) => e.department).filter(Boolean))).sort(),
    [employees],
  )
  const designations = useMemo(
    () => Array.from(new Set(employees.map((e) => e.designation).filter(Boolean))).sort(),
    [employees],
  )

  const documents = data?.documents || []
  const summary = data?.summary

  // Selection for bulk actions
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const allVisibleSelected = documents.length > 0 && documents.every((d) => selected.has(d.id))
  const toggleAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(documents.map((d) => d.id)))
  const selectedRows = documents.filter((d) => selected.has(d.id))

  // Dialog state
  const [rejectFor, setRejectFor] = useState<Doc | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [replaceFor, setReplaceFor] = useState<Doc | null>(null)
  const [replaceFile, setReplaceFile] = useState<File | null>(null)
  const [deleteFor, setDeleteFor] = useState<Doc | null>(null)
  const [busy, setBusy] = useState(false)

  function resetFilters() {
    setQ("")
    setFEmployee("")
    setFDept("")
    setFDesignation("")
    setFType("")
    setFStatus("")
    setFExpiry("")
    setUploadedFrom("")
    setUploadedTo("")
    setView("active")
  }

  async function patch(action: string, ids: number[], extra: Record<string, unknown> = {}) {
    setBusy(true)
    try {
      const res = await fetch("/api/hr/employee-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids, ...extra }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Action failed")
      setSelected(new Set())
      mutate()
      return true
    } catch (err) {
      toast.error((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onVerify(doc: Doc) {
    if (await patch("verify", [doc.id])) toast.success(`${doc.document_type} verified`)
  }
  async function onReject() {
    if (!rejectFor) return
    if (!rejectReason.trim()) {
      toast.error("A rejection reason is required.")
      return
    }
    if (await patch("reject", [rejectFor.id], { reason: rejectReason.trim() })) {
      toast.success(`${rejectFor.document_type} rejected`)
      setRejectFor(null)
      setRejectReason("")
    }
  }
  async function onArchive(doc: Doc) {
    if (await patch("archive", [doc.id])) toast.success(`${doc.document_type} archived`)
  }
  async function onRestore(doc: Doc) {
    if (await patch("restore", [doc.id])) toast.success(`${doc.document_type} restored`)
  }
  async function onDelete() {
    if (!deleteFor) return
    setBusy(true)
    try {
      const res = await fetch(`/api/hr/employee-documents?id=${deleteFor.id}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Delete failed")
      toast.success("Document permanently deleted")
      setDeleteFor(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function onReplace() {
    if (!replaceFor || !replaceFile) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set("employee_id", String(replaceFor.employee_id))
      fd.set("document_type", replaceFor.document_type)
      fd.set("replace_of", String(replaceFor.id))
      if (replaceFor.document_number) fd.set("document_number", replaceFor.document_number)
      if (replaceFor.expiry_date) fd.set("expiry_date", replaceFor.expiry_date)
      fd.set("file", replaceFile)
      const res = await fetch("/api/hr/employee-documents", { method: "POST", body: fd })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Replace failed")
      toast.success(`New version created (v${body.version})`)
      setReplaceFor(null)
      setReplaceFile(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <FileCheck2 className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">{isSelf ? "My Documents" : "Employee Documents"}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSelf
              ? "Upload and track your own documents. HR verifies and manages versions."
              : "Document management & compliance — verification, expiry, versioning and audit."}
          </p>
        </div>
        <ExcelExportButton
          rows={selectedRows.length ? selectedRows : documents}
          filename="employee-documents"
          columns={[
            { header: "Document ID", value: (r: Doc) => r.document_ref },
            { header: "Employee", value: (r: Doc) => r.employee_name },
            { header: "Employee Code", value: (r: Doc) => r.employee_code },
            { header: "Department", value: (r: Doc) => r.department },
            { header: "Designation", value: (r: Doc) => r.designation },
            { header: "Document Type", value: (r: Doc) => r.document_type },
            { header: "Document Number", value: (r: Doc) => r.document_number },
            { header: "Version", value: (r: Doc) => r.version },
            { header: "Status", value: (r: Doc) => r.status },
            { header: "Expiry Status", value: (r: Doc) => r.expiry_status },
            { header: "Issue Date", value: (r: Doc) => r.issue_date },
            { header: "Expiry Date", value: (r: Doc) => r.expiry_date },
            { header: "File Name", value: (r: Doc) => r.file_name },
            { header: "Uploaded By", value: (r: Doc) => r.uploader_name },
            { header: "Uploaded", value: (r: Doc) => r.created_at },
            { header: "Verified By", value: (r: Doc) => r.verifier_name },
            { header: "Remarks", value: (r: Doc) => r.remarks },
          ]}
        />
      </div>

      {/* Compliance summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCard icon={<FileCheck2 className="size-4" />} label="Total" value={summary.total} />
          <SummaryCard icon={<Clock className="size-4" />} label="Pending" value={summary.pending} tone="amber" />
          <SummaryCard
            icon={<CircleSlash className="size-4" />}
            label="Missing Required"
            value={summary.missingRequired}
            tone={summary.missingRequired > 0 ? "red" : undefined}
            hint={fEmployee ? undefined : "Select an employee"}
          />
          <SummaryCard
            icon={<AlertTriangle className="size-4" />}
            label="Expiring Soon"
            value={summary.expiringSoon}
            tone="amber"
          />
          <SummaryCard icon={<AlertTriangle className="size-4" />} label="Expired" value={summary.expired} tone="red" />
          <SummaryCard icon={<ShieldCheck className="size-4" />} label="Verified" value={summary.verified} tone="emerald" />
        </div>
      )}

      {/* Required-document checklist (per selected employee) */}
      {data?.checklist && data.checklist.length > 0 && (
        <ChecklistPanel checklist={data.checklist} />
      )}

      {/* Upload form */}
      {canUpload && <UploadForm isSelf={isSelf} employees={employees} documentTypes={documentTypes} onDone={mutate} />}

      {/* Filters */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, employee ID, document ID or number"
              className="pl-8"
            />
          </div>
          {!isSelf && (
            <FilterSelect label="Employee" value={fEmployee} onChange={setFEmployee} placeholder="All employees">
              {employees.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.employee_id} · {e.employee_name}
                </SelectItem>
              ))}
            </FilterSelect>
          )}
          {!isSelf && (
            <FilterSelect label="Department" value={fDept} onChange={setFDept} placeholder="All">
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </FilterSelect>
          )}
          {!isSelf && (
            <FilterSelect label="Designation" value={fDesignation} onChange={setFDesignation} placeholder="All">
              {designations.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </FilterSelect>
          )}
          <FilterSelect label="Type" value={fType} onChange={setFType} placeholder="All">
            {documentTypes.map((t) => (
              <SelectItem key={t.id} value={t.type_name}>
                {t.type_name}
              </SelectItem>
            ))}
          </FilterSelect>
          <FilterSelect label="Status" value={fStatus} onChange={setFStatus} placeholder="All">
            <SelectItem value="Pending">Pending</SelectItem>
            <SelectItem value="Verified">Verified</SelectItem>
            <SelectItem value="Rejected">Rejected</SelectItem>
          </FilterSelect>
          <FilterSelect label="Expiry" value={fExpiry} onChange={setFExpiry} placeholder="All">
            <SelectItem value="Valid">Valid</SelectItem>
            <SelectItem value="Expiring Soon">Expiring Soon</SelectItem>
            <SelectItem value="Expired">Expired</SelectItem>
          </FilterSelect>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Uploaded from</Label>
            <Input type="date" value={uploadedFrom} onChange={(e) => setUploadedFrom(e.target.value)} className="w-[150px]" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Uploaded to</Label>
            <Input type="date" value={uploadedTo} onChange={(e) => setUploadedTo(e.target.value)} className="w-[150px]" />
          </div>
          {canManage && (
            <FilterSelect
              label="View"
              value={view}
              onChange={(v) => setView((v as "active" | "archived") || "active")}
              placeholder="Active"
              clearable={false}
            >
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </FilterSelect>
          )}
          <Button variant="ghost" onClick={resetFilters} className="h-9">
            Reset
          </Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {canManage && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <span className="text-sm font-medium">{selected.size} selected</span>
          {view === "active" ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => patch("verify", [...selected])}>
                <Check className="mr-1 size-3.5" /> Verify
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => patch("archive", [...selected])}>
                <Archive className="mr-1 size-3.5" /> Archive
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => patch("restore", [...selected])}>
              <ArchiveRestore className="mr-1 size-3.5" /> Restore
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              {canManage && (
                <th className="w-10 p-3">
                  <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                </th>
              )}
              <th className="whitespace-nowrap p-3 font-medium">Document ID</th>
              {!isSelf && <th className="whitespace-nowrap p-3 font-medium">Employee</th>}
              <th className="whitespace-nowrap p-3 font-medium">Type</th>
              <th className="whitespace-nowrap p-3 font-medium">Ver.</th>
              <th className="whitespace-nowrap p-3 font-medium">Doc #</th>
              <th className="whitespace-nowrap p-3 font-medium">Status</th>
              <th className="whitespace-nowrap p-3 font-medium">Expiry</th>
              <th className="whitespace-nowrap p-3 font-medium">Uploaded</th>
              <th className="whitespace-nowrap p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={12} className="p-8 text-center text-muted-foreground">
                  Loading documents…
                </td>
              </tr>
            )}
            {!isLoading && documents.length === 0 && (
              <tr>
                <td colSpan={12} className="p-10 text-center text-muted-foreground">
                  <FileCheck2 className="mx-auto mb-2 size-8 opacity-40" />
                  No documents match the current filters.
                </td>
              </tr>
            )}
            {documents.map((d) => (
              <tr key={d.id} className="border-t align-middle">
                {canManage && (
                  <td className="p-3">
                    <Checkbox
                      checked={selected.has(d.id)}
                      onCheckedChange={() => toggle(d.id)}
                      aria-label={`Select ${d.document_ref}`}
                    />
                  </td>
                )}
                <td className="whitespace-nowrap p-3 font-mono text-xs">{d.document_ref || "—"}</td>
                {!isSelf && (
                  <td className="whitespace-nowrap p-3">
                    <div className="font-medium">{d.employee_name}</div>
                    <div className="text-xs text-muted-foreground">{d.employee_code}</div>
                  </td>
                )}
                <td className="whitespace-nowrap p-3">{d.document_type}</td>
                <td className="whitespace-nowrap p-3">
                  <span className="inline-flex items-center gap-1.5">
                    v{d.version}
                    {d.is_current === 1 && (
                      <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                        Current
                      </Badge>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap p-3">{d.document_number || "—"}</td>
                <td className="whitespace-nowrap p-3">
                  <Badge variant="outline" className={STATUS_STYLES[d.status] || ""}>
                    {d.status}
                  </Badge>
                  {d.status === "Rejected" && d.rejection_reason && (
                    <div className="mt-1 max-w-[180px] truncate text-xs text-red-400" title={d.rejection_reason}>
                      {d.rejection_reason}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap p-3">
                  {d.expiry_status && d.expiry_status !== "None" ? (
                    <Badge variant="outline" className={EXPIRY_STYLES[d.expiry_status] || ""}>
                      {d.expiry_status}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                  {d.expiry_date && <div className="mt-0.5 text-xs text-muted-foreground">{d.expiry_date}</div>}
                </td>
                <td className="whitespace-nowrap p-3">
                  <div className="text-xs">{(d.created_at || "").slice(0, 10)}</div>
                  <div className="text-xs text-muted-foreground">{d.uploader_name || ""}</div>
                </td>
                <td className="whitespace-nowrap p-3">
                  <div className="flex items-center justify-end gap-1">
                    {d.file_path && (
                      <>
                        <IconLink href={`/api/hr/employee-documents/file?pathname=${d.file_path}`} title="View">
                          <Eye className="size-4" />
                        </IconLink>
                        <IconLink
                          href={`/api/hr/employee-documents/file?pathname=${d.file_path}&download=1`}
                          title="Download"
                          download
                        >
                          <Download className="size-4" />
                        </IconLink>
                      </>
                    )}
                    {canManage && view === "active" && (
                      <>
                        {d.status !== "Verified" && (
                          <IconButton title="Verify" onClick={() => onVerify(d)}>
                            <Check className="size-4 text-emerald-400" />
                          </IconButton>
                        )}
                        {d.status !== "Rejected" && (
                          <IconButton title="Reject" onClick={() => setRejectFor(d)}>
                            <X className="size-4 text-red-400" />
                          </IconButton>
                        )}
                        <IconButton title="Replace with new version" onClick={() => setReplaceFor(d)}>
                          <RefreshCw className="size-4" />
                        </IconButton>
                        <IconButton title="Archive" onClick={() => onArchive(d)}>
                          <Archive className="size-4" />
                        </IconButton>
                      </>
                    )}
                    {canManage && view === "archived" && (
                      <IconButton title="Restore" onClick={() => onRestore(d)}>
                        <ArchiveRestore className="size-4" />
                      </IconButton>
                    )}
                    {canDelete && (
                      <IconButton title="Permanently delete" onClick={() => setDeleteFor(d)}>
                        <Trash2 className="size-4 text-red-400" />
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reject dialog */}
      <Dialog open={!!rejectFor} onOpenChange={(o) => !o && (setRejectFor(null), setRejectReason(""))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject document</DialogTitle>
            <DialogDescription>
              {rejectFor ? `Provide a reason for rejecting ${rejectFor.document_type} (${rejectFor.document_ref}).` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Rejection reason</Label>
            <Textarea
              id="reject-reason"
              rows={4}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Document is blurry / expired / wrong file"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => (setRejectFor(null), setRejectReason(""))} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onReject} disabled={busy || !rejectReason.trim()}>
              Reject document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace dialog */}
      <Dialog open={!!replaceFor} onOpenChange={(o) => !o && (setReplaceFor(null), setReplaceFile(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace document</DialogTitle>
            <DialogDescription>
              {replaceFor
                ? `Upload a new file for ${replaceFor.document_type}. The current version (v${replaceFor.version}) is preserved as history and the new upload becomes current.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="replace-file">New file</Label>
            <Input id="replace-file" type="file" onChange={(e) => setReplaceFile(e.target.files?.[0] || null)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => (setReplaceFor(null), setReplaceFile(null))} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={onReplace} disabled={busy || !replaceFile}>
              {busy ? "Uploading…" : "Create new version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Permanent delete confirm */}
      <AlertDialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFor
                ? `This permanently removes ${deleteFor.document_type} (${deleteFor.document_ref}) and its file. This cannot be undone — prefer Archive to keep history.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                onDelete()
              }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone?: "amber" | "red" | "emerald"
  hint?: string
}) {
  const toneClass =
    tone === "amber"
      ? "text-amber-400"
      : tone === "red"
        ? "text-red-400"
        : tone === "emerald"
          ? "text-emerald-400"
          : "text-foreground"
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={toneClass}>{icon}</span>
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{hint ? "—" : value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

function ChecklistPanel({
  checklist,
}: {
  checklist: { type: string; required: boolean; uploaded: boolean; verified: boolean }[]
}) {
  const complete = checklist.filter((c) => c.uploaded).length
  const pct = checklist.length ? Math.round((complete / checklist.length) * 100) : 0
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Required document checklist</h2>
        <span className="text-sm text-muted-foreground">
          {complete} / {checklist.length} Required Documents Complete
        </span>
      </div>
      <Progress value={pct} className="mb-4 h-2" />
      <div className="flex flex-wrap gap-2">
        {checklist.map((c) => (
          <Badge
            key={c.type}
            variant="outline"
            className={
              c.verified
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : c.uploaded
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                  : "border-red-500/40 bg-red-500/10 text-red-400"
            }
          >
            {c.type}: {c.verified ? "Verified" : c.uploaded ? "Uploaded" : "Missing"}
          </Badge>
        ))}
      </div>
    </div>
  )
}

function UploadForm({
  isSelf,
  employees,
  documentTypes,
  onDone,
}: {
  isSelf: boolean
  employees: any[]
  documentTypes: DocType[]
  onDone: () => void
}) {
  const [employeeId, setEmployeeId] = useState("")
  const [type, setType] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [documentNumber, setDocumentNumber] = useState("")
  const [issueDate, setIssueDate] = useState("")
  const [expiryDate, setExpiryDate] = useState("")
  const [remarks, setRemarks] = useState("")
  const [saving, setSaving] = useState(false)
  const selectedType = documentTypes.find((t) => t.type_name === type)
  const hasExpiry = selectedType?.has_expiry === 1

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    if ((!isSelf && !employeeId) || !type) {
      toast.error("Employee and document type are required.")
      return
    }
    setSaving(true)
    const fd = new FormData()
    if (!isSelf) fd.set("employee_id", employeeId)
    fd.set("document_type", type)
    if (documentNumber) fd.set("document_number", documentNumber)
    if (issueDate) fd.set("issue_date", issueDate)
    if (hasExpiry && expiryDate) fd.set("expiry_date", expiryDate)
    fd.set("remarks", remarks)
    if (file) fd.set("file", file)
    const res = await fetch("/api/hr/employee-documents", { method: "POST", body: fd })
    const body = await res.json().catch(() => ({}))
    setSaving(false)
    if (res.ok) {
      toast.success(`Document uploaded (${body.document_ref})`)
      setEmployeeId("")
      setType("")
      setFile(null)
      setDocumentNumber("")
      setIssueDate("")
      setExpiryDate("")
      setRemarks("")
      onDone()
    } else {
      toast.error(body?.error || "Upload failed")
    }
  }

  return (
    <form onSubmit={upload} className="grid gap-4 rounded-lg border bg-card p-5 md:grid-cols-3 lg:grid-cols-4">
      {!isSelf && (
        <div className="grid gap-2">
          <Label>Employee</Label>
          <Select value={employeeId} onValueChange={(v) => setEmployeeId(v || "")}>
            <SelectTrigger>
              <SelectValue placeholder="Select employee" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.employee_id} · {e.employee_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-2">
        <Label>Document type</Label>
        <Select value={type} onValueChange={(v) => setType(v || "")}>
          <SelectTrigger>
            <SelectValue placeholder="Select document" />
          </SelectTrigger>
          <SelectContent>
            {documentTypes.map((t) => (
              <SelectItem key={t.id} value={t.type_name}>
                {t.type_name}
                {t.is_required === 1 ? " *" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label>File</Label>
        <Input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </div>
      <div className="grid gap-2">
        <Label>Document number (optional)</Label>
        <Input value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="e.g. ABCDE1234F" />
      </div>
      <div className="grid gap-2">
        <Label>Issue date (optional)</Label>
        <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
      </div>
      {hasExpiry && (
        <div className="grid gap-2">
          <Label>Expiry date</Label>
          <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </div>
      )}
      <div className="grid gap-2 md:col-span-2">
        <Label>Remarks (optional)</Label>
        <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Notes" />
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={saving} className="w-full md:w-auto">
          <Upload className="mr-2 size-4" />
          {saving ? "Uploading…" : "Upload document"}
        </Button>
      </div>
    </form>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  placeholder,
  children,
  clearable = true,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  children: React.ReactNode
  clearable?: boolean
}) {
  const ALL = "__all__"
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {clearable && <SelectItem value={ALL}>{placeholder}</SelectItem>}
          {children}
        </SelectContent>
      </Select>
    </div>
  )
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </button>
  )
}

function IconLink({
  href,
  title,
  children,
  download,
}: {
  href: string
  title: string
  children: React.ReactNode
  download?: boolean
}) {
  return (
    <a
      href={href}
      title={title}
      aria-label={title}
      target="_blank"
      rel="noreferrer"
      download={download}
      className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </a>
  )
}
