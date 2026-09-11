"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
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
import { Check, Plus, Trash2, X } from "lucide-react"

type DocType = {
  id: number
  type_name: string
  is_required: 0 | 1
  has_expiry: 0 | 1
  expiry_warn_days: number
  status: string
  sort_order: number
}

// Editable master for the document types consumed by Employee Documents. Kept
// intentionally distinct from the generic master-data CRUD because these rows
// carry boolean flags and a per-type expiry window that need proper controls.
export function DocumentTypesManager() {
  const { data, mutate, isLoading } = useSWR<{ rows: DocType[] }>("/api/hr/master-data/document-types", fetcher)
  const rows = data?.rows || []

  const [name, setName] = useState("")
  const [required, setRequired] = useState(false)
  const [hasExpiry, setHasExpiry] = useState(false)
  const [warnDays, setWarnDays] = useState("30")
  const [busy, setBusy] = useState(false)
  const [deleteFor, setDeleteFor] = useState<DocType | null>(null)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      toast.error("Enter a document type name.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/hr/master-data/document-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type_name: name.trim(),
          is_required: required,
          has_expiry: hasExpiry,
          expiry_warn_days: Number(warnDays) || 30,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Failed to add document type")
      toast.success(`Added "${name.trim()}"`)
      setName("")
      setRequired(false)
      setHasExpiry(false)
      setWarnDays("30")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: number, patch: Partial<DocType>) {
    const res = await fetch("/api/hr/master-data/document-types", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body?.error || "Update failed")
      return
    }
    mutate()
  }

  async function onDelete() {
    if (!deleteFor) return
    setBusy(true)
    try {
      const res = await fetch(`/api/hr/master-data/document-types?id=${deleteFor.id}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Delete failed")
      toast.success(body.deactivated ? "Type is in use — deactivated instead" : "Document type deleted")
      setDeleteFor(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        These types drive the Employee Documents upload dropdown, the required-document checklist and expiry tracking.
        Required types appear in every employee&apos;s compliance checklist automatically.
      </p>

      {/* Add form */}
      <form onSubmit={add} className="grid gap-4 rounded-xl border bg-card p-5 md:grid-cols-2 lg:grid-cols-5">
        <div className="grid gap-2 lg:col-span-2">
          <Label>Type name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aadhar, Passport, NDA" />
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={required} onCheckedChange={(v) => setRequired(!!v)} />
            Required
          </label>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={hasExpiry} onCheckedChange={(v) => setHasExpiry(!!v)} />
            Has expiry
          </label>
        </div>
        <div className="grid gap-2">
          <Label>Warn (days)</Label>
          <Input
            type="number"
            min={0}
            value={warnDays}
            onChange={(e) => setWarnDays(e.target.value)}
            disabled={!hasExpiry}
          />
        </div>
        <div className="flex items-end lg:col-span-5">
          <Button type="submit" disabled={busy}>
            <Plus className="mr-2 size-4" />
            Add document type
          </Button>
        </div>
      </form>

      {/* Table */}
      <div className="overflow-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-medium">Type</th>
              <th className="p-3 font-medium">Required</th>
              <th className="p-3 font-medium">Expiry</th>
              <th className="p-3 font-medium">Warn (days)</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  Loading document types…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  No document types configured yet.
                </td>
              </tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} className="border-t align-middle">
                <td className="p-3 font-medium">{t.type_name}</td>
                <td className="p-3">
                  <Toggle
                    on={t.is_required === 1}
                    onLabel="Required"
                    offLabel="Optional"
                    onToggle={() => patch(t.id, { is_required: (t.is_required === 1 ? 0 : 1) as 0 | 1 })}
                  />
                </td>
                <td className="p-3">
                  <Toggle
                    on={t.has_expiry === 1}
                    onLabel="Tracks expiry"
                    offLabel="No expiry"
                    onToggle={() => patch(t.id, { has_expiry: (t.has_expiry === 1 ? 0 : 1) as 0 | 1 })}
                  />
                </td>
                <td className="p-3">
                  {t.has_expiry === 1 ? (
                    <Input
                      type="number"
                      min={0}
                      defaultValue={t.expiry_warn_days}
                      className="h-8 w-20"
                      onBlur={(e) => {
                        const v = Math.max(0, Number(e.target.value) || 30)
                        if (v !== t.expiry_warn_days) patch(t.id, { expiry_warn_days: v })
                      }}
                    />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => patch(t.id, { status: t.status === "Active" ? "Inactive" : "Active" })}
                    title="Toggle active status"
                  >
                    <Badge
                      variant="outline"
                      className={
                        t.status === "Active"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                          : "border-muted bg-muted/40 text-muted-foreground"
                      }
                    >
                      {t.status}
                    </Badge>
                  </button>
                </td>
                <td className="p-3">
                  <div className="flex items-center justify-end">
                    <button
                      type="button"
                      title="Delete document type"
                      aria-label="Delete document type"
                      onClick={() => setDeleteFor(t)}
                      className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
                    >
                      <Trash2 className="size-4 text-red-400" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document type?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFor
                ? `If any employee documents already use "${deleteFor.type_name}", it will be deactivated instead of deleted so existing records stay intact.`
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
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Toggle({
  on,
  onLabel,
  offLabel,
  onToggle,
}: {
  on: boolean
  onLabel: string
  offLabel: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent"
    >
      {on ? <Check className="size-3.5 text-emerald-400" /> : <X className="size-3.5 text-muted-foreground" />}
      {on ? onLabel : offLabel}
    </button>
  )
}
