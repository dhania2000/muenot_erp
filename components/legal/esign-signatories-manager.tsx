"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Loader2, PenTool, Trash2, Pencil } from "lucide-react"
import { SignaturePad } from "@/components/legal/signature-pad"
import { SIGNATORY_STATUSES, type EsignSignatory, type SignatoryStatus } from "@/lib/legal-esign-shared"

function statusTone(status: SignatoryStatus): string {
  switch (status) {
    case "Active":
      return "bg-emerald-100 text-emerald-700 ring-emerald-600/20"
    case "Inactive":
      return "bg-slate-100 text-slate-700 ring-slate-600/20"
    case "Revoked":
      return "bg-rose-100 text-rose-700 ring-rose-600/20"
    default:
      return "bg-slate-100 text-slate-700 ring-slate-600/20"
  }
}

export function EsignSignatoriesManager({ canManage }: { canManage: boolean }) {
  const { data, mutate, isLoading } = useSWR<{ signatories: EsignSignatory[] }>(
    "/api/legal/esign/signatories",
    fetcher,
  )
  const signatories = data?.signatories || []
  const [editing, setEditing] = useState<EsignSignatory | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Authorized signatories are Muenot representatives who sign documents from inside the ERP using a saved
          signature — no email round-trip required.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" />
            Add signatory
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Name", "Designation", "Department", "Signature", "Status", ""].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signatories.map((s) => (
              <tr key={s.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium">
                  {s.name}
                  {s.is_default ? (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-normal text-primary">
                      Default
                    </span>
                  ) : null}
                  {s.email ? <div className="text-xs font-normal text-muted-foreground">{s.email}</div> : null}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{s.designation || "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{s.department || "—"}</td>
                <td className="px-4 py-3">
                  {s.signature_status === "Uploaded" ? (
                    <img
                      src={`/api/legal/esign/signatories/${s.id}/signature`}
                      alt={`${s.name} signature`}
                      className="h-8 w-auto max-w-[140px] object-contain"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">Not set</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusTone(
                      s.status,
                    )}`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {canManage && (
                    <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                      <Pencil className="size-4" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!isLoading && signatories.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                  No authorized signatories yet.
                  {canManage ? ' Use "Add signatory" to create one.' : ""}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <SignatoryDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            mutate()
          }}
        />
      )}
      {editing && (
        <SignatoryDialog
          signatory={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            mutate()
          }}
        />
      )}
    </div>
  )
}

function SignatoryDialog({
  signatory,
  onClose,
  onSaved,
}: {
  signatory?: EsignSignatory
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!signatory
  const [name, setName] = useState(signatory?.name ?? "")
  const [designation, setDesignation] = useState(signatory?.designation ?? "")
  const [department, setDepartment] = useState(signatory?.department ?? "")
  const [email, setEmail] = useState(signatory?.email ?? "")
  const [status, setStatus] = useState<SignatoryStatus>(signatory?.status ?? "Active")
  const [signatureData, setSignatureData] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) {
      toast.error("A signatory name is required")
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        designation: designation.trim() || null,
        department: department.trim() || null,
        email: email.trim() || null,
        ...(isEdit ? { status } : {}),
      }
      const res = await fetch(isEdit ? `/api/legal/esign/signatories/${signatory!.id}` : "/api/legal/esign/signatories", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(d.error || "Could not save signatory")
        return
      }
      const id = isEdit ? signatory!.id : d.signatory?.id
      if (signatureData && id) {
        const sigRes = await fetch(`/api/legal/esign/signatories/${id}/signature`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageData: signatureData }),
        })
        if (!sigRes.ok) {
          const sd = await sigRes.json().catch(() => ({}))
          toast.error(sd.error || "Signatory saved, but the signature could not be uploaded")
          onSaved()
          return
        }
      }
      toast.success(isEdit ? "Signatory updated" : "Signatory added")
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit signatory" : "Add authorized signatory"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update details or replace the saved signature."
              : "Add a Muenot representative who can sign documents from inside the ERP."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sig-name">Name</Label>
              <Input id="sig-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sig-designation">Designation</Label>
              <Input
                id="sig-designation"
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
                placeholder="e.g. Director"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sig-department">Department</Label>
              <Input
                id="sig-department"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. Finance"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sig-email">Email</Label>
              <Input
                id="sig-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@muenot.com"
              />
            </div>
          </div>

          {isEdit && (
            <div className="flex flex-col gap-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as SignatoryStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIGNATORY_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center gap-1.5">
              <PenTool className="size-4" />
              {isEdit && signatory?.signature_status === "Uploaded"
                ? "Replace saved signature (optional)"
                : "Saved signature"}
            </Label>
            {isEdit && signatory?.signature_status === "Uploaded" && (
              <img
                src={`/api/legal/esign/signatories/${signatory.id}/signature`}
                alt="Current signature"
                className="mb-1 h-12 w-auto max-w-[200px] rounded border bg-white object-contain p-1"
              />
            )}
            <SignaturePad onChange={setSignatureData} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
            {isEdit ? "Save changes" : "Add signatory"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
