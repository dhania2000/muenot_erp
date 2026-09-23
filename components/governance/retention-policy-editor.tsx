"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Archive, Gavel, Plus, Settings2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { RETENTION_UNITS, type RetentionUnit } from "@/lib/retention-model"
import type { RetentionPolicy, RetentionCatalogItem } from "./retention-types"
import { RetentionPolicyDetail } from "./retention-policy-detail"

const API = "/api/admin/governance/retention"

type ListResponse = { policies: RetentionPolicy[]; catalog: RetentionCatalogItem[] }

const CUSTOM = "__custom__"

const runStateTone: Record<RetentionPolicy["runState"], "secondary" | "outline" | "destructive"> = {
  active: "secondary",
  paused: "outline",
  held: "destructive",
}

/** Decompose a day count into the largest clean value + unit for the edit form. */
function daysToValueUnit(days: number): { value: number; unit: RetentionUnit } {
  if (days > 0 && days % 365 === 0) return { value: days / 365, unit: "years" }
  if (days > 0 && days % 30 === 0) return { value: days / 30, unit: "months" }
  return { value: days, unit: "days" }
}

type Draft = {
  catalogKey: string
  module: string
  recordType: string
  retentionValue: number
  retentionUnit: RetentionUnit
  action: "archive" | "delete"
  purgeAfterArchive: boolean
}

function emptyDraft(): Draft {
  return {
    catalogKey: "",
    module: "",
    recordType: "",
    retentionValue: 7,
    retentionUnit: "years",
    action: "archive",
    purgeAfterArchive: false,
  }
}

export function RetentionPolicyEditor() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(API, fetcher)
  const [creating, setCreating] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<RetentionPolicy | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)

  const policies = data?.policies ?? []
  const catalog = data?.catalog ?? []

  // Only offer catalog record types that don't already have a policy.
  const availableCatalog = useMemo(() => {
    const used = new Set(policies.map((p) => p.catalogKey).filter(Boolean))
    return catalog.filter((c) => !used.has(c.key))
  }, [catalog, policies])

  const selectedCatalog =
    creating && creating.catalogKey && creating.catalogKey !== CUSTOM
      ? catalog.find((c) => c.key === creating.catalogKey)
      : undefined

  function onPickCatalog(key: string) {
    if (!creating) return
    if (key === CUSTOM) {
      setCreating({ ...creating, catalogKey: CUSTOM, module: "", recordType: "", action: "archive" })
      return
    }
    const entry = catalog.find((c) => c.key === key)
    if (!entry) return
    const { value, unit } = daysToValueUnit(entry.suggestedDays)
    setCreating({
      ...creating,
      catalogKey: key,
      module: entry.module,
      recordType: entry.recordType,
      retentionValue: value,
      retentionUnit: unit,
      action: entry.allowDelete ? creating.action : "archive",
    })
  }

  async function create() {
    if (!creating) return
    const isCustom = creating.catalogKey === CUSTOM || creating.catalogKey === ""
    if (isCustom && (!creating.module.trim() || !creating.recordType.trim())) {
      toast.error("Module and record type are required.")
      return
    }
    if (!isCustom && !creating.catalogKey) {
      toast.error("Choose a record type.")
      return
    }
    setSaving(true)
    try {
      const payload = {
        catalogKey: isCustom ? null : creating.catalogKey,
        module: creating.module.trim(),
        recordType: creating.recordType.trim(),
        retentionValue: creating.retentionValue,
        retentionUnit: creating.retentionUnit,
        action: creating.action,
        purgeAfterArchive: creating.action === "archive" ? creating.purgeAfterArchive : true,
        status: "active",
      }
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not create policy")
      }
      toast.success("Retention policy created.")
      setCreating(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      const res = await fetch(`${API}/${deleting.id}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not delete policy")
      }
      toast.success("Policy deleted.")
      setDeleting(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const deleteAllowed = selectedCatalog ? selectedCatalog.allowDelete : true

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Archive className="size-4 text-muted-foreground" />
              Retention policies
            </CardTitle>
            <CardDescription>
              Bind any ERP record type to a retention window and an action. The daily lifecycle job archives or deletes
              records past their window — respecting legal holds, exceptions and data-classification rules — and writes
              an immutable audit entry for every run.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setCreating(emptyDraft())}>
            <Plus className="size-3.5" />
            New policy
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <p className="p-6 text-sm text-destructive">{(error as Error).message}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Record type</TableHead>
                  <TableHead>Retention</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : policies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      No retention policies yet. Add one to start the automated lifecycle.
                    </TableCell>
                  </TableRow>
                ) : (
                  policies.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {p.module}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="flex items-center gap-1.5">
                          {p.recordType}
                          {!p.catalogKey && (
                            <Badge variant="secondary" className="text-[10px]">
                              custom
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{p.retentionLabel}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1 text-sm capitalize">
                          {p.action === "delete" ? (
                            <Trash2 className="size-3.5 text-destructive" />
                          ) : (
                            <Archive className="size-3.5 text-muted-foreground" />
                          )}
                          {p.action}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <Badge variant={runStateTone[p.runState]} className="text-[10px] capitalize">
                            {p.runState}
                          </Badge>
                          {p.legalHold && <Gavel className="size-3.5 text-destructive" aria-label="Legal hold" />}
                          {p.exceptionCount > 0 && (
                            <span className="text-[10px] text-muted-foreground">{p.exceptionCount} exc.</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.lastRunAt ? new Date(p.lastRunAt).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Manage ${p.recordType}`}
                            onClick={() => setDetailId(p.id)}
                          >
                            <Settings2 className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${p.recordType}`}
                            onClick={() => setDeleting(p)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* New policy */}
      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New retention policy</DialogTitle>
            <DialogDescription>
              Pick a known ERP record type for an automated lifecycle, or define a custom one to track manually.
            </DialogDescription>
          </DialogHeader>
          {creating && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="rp-catalog">Record type</Label>
                <Select value={creating.catalogKey} onValueChange={(v) => onPickCatalog(v ?? "")}>
                  <SelectTrigger id="rp-catalog" className="w-full">
                    <SelectValue placeholder="Choose a record type" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableCatalog.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.module} — {c.recordType}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM}>Custom record type…</SelectItem>
                  </SelectContent>
                </Select>
                {selectedCatalog && (
                  <p className="text-xs text-muted-foreground">{selectedCatalog.description}</p>
                )}
              </div>

              {creating.catalogKey === CUSTOM && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="rp-module">Module</Label>
                    <Input
                      id="rp-module"
                      value={creating.module}
                      onChange={(e) => setCreating({ ...creating, module: e.target.value })}
                      placeholder="e.g. Legal"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="rp-type">Record type</Label>
                    <Input
                      id="rp-type"
                      value={creating.recordType}
                      onChange={(e) => setCreating({ ...creating, recordType: e.target.value })}
                      placeholder="e.g. Signed NDAs"
                    />
                  </div>
                </div>
              )}

              <div className="grid gap-2">
                <Label>Retention period</Label>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    type="number"
                    min={1}
                    value={creating.retentionValue}
                    onChange={(e) =>
                      setCreating({ ...creating, retentionValue: Math.max(1, Number(e.target.value) || 1) })
                    }
                    aria-label="Retention value"
                  />
                  <Select
                    value={creating.retentionUnit}
                    onValueChange={(v) => setCreating({ ...creating, retentionUnit: v as RetentionUnit })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RETENTION_UNITS.map((u) => (
                        <SelectItem key={u} value={u} className="capitalize">
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="rp-action">Action once expired</Label>
                <Select
                  value={creating.action}
                  onValueChange={(v) => setCreating({ ...creating, action: v as "archive" | "delete" })}
                >
                  <SelectTrigger id="rp-action" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="archive">Archive (seal into immutable store)</SelectItem>
                    <SelectItem value="delete" disabled={!deleteAllowed}>
                      Delete permanently{!deleteAllowed ? " — not allowed for this type" : ""}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {creating.action === "archive" && (
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="pr-4">
                    <Label htmlFor="rp-purge" className="text-sm font-normal">
                      Purge from live table after archiving
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      When off, records stay in the live table and only a sealed copy is archived.
                    </p>
                  </div>
                  <Switch
                    id="rp-purge"
                    checked={creating.purgeAfterArchive}
                    onCheckedChange={(checked) => setCreating({ ...creating, purgeAfterArchive: checked })}
                  />
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={create} disabled={saving}>
              {saving ? "Creating…" : "Create policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this retention policy?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the policy “{deleting?.module} / {deleting?.recordType}” and its exceptions. Records already
              archived remain in the immutable store. This does not delete any live records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete policy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RetentionPolicyDetail
        policyId={detailId}
        open={detailId !== null}
        onOpenChange={(open) => !open && setDetailId(null)}
        onChanged={() => mutate()}
      />
    </>
  )
}
