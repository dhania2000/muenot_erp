"use client"

import { useState } from "react"
import useSWR from "swr"
import { Pencil, Plus, ShieldCheck, Tag, Trash2 } from "lucide-react"
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
import {
  CLASSIFICATION_LEVELS,
  type ClassificationLevel,
  type ClearanceMatrix,
} from "@/lib/data-classification-model"

const API = "/api/admin/governance/classification"

const TENANT_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "employee", label: "Employee" },
  { value: "module_admin", label: "Module Admin" },
  { value: "tenant_admin", label: "Tenant Admin" },
  { value: "tenant_owner", label: "Tenant Owner" },
]

const LEVELS: { level: ClassificationLevel; tone: "secondary" | "outline" | "destructive"; description: string }[] = [
  { level: "Public", tone: "secondary", description: "No restriction. Safe for any audience." },
  { level: "Internal", tone: "outline", description: "Employees only. Not for external sharing." },
  { level: "Confidential", tone: "outline", description: "Restricted to a defined business need." },
  { level: "Restricted", tone: "destructive", description: "Named roles only, logged access." },
  { level: "Highly Restricted", tone: "destructive", description: "Named individuals only, dual control." },
]

function levelTone(level: string): "secondary" | "outline" | "destructive" {
  return LEVELS.find((l) => l.level === level)?.tone ?? "outline"
}

type Mapping = {
  id: number
  module: string
  entity: string
  field: string
  level: ClassificationLevel
  enforceAccess: boolean
  enforceExport: boolean
  enforceRetention: boolean
  createdByName: string | null
}

type ApiResponse = { mappings: Mapping[]; clearance: ClearanceMatrix }

type Draft = {
  id?: number
  isNew: boolean
  module: string
  entity: string
  field: string
  level: ClassificationLevel
  enforceAccess: boolean
  enforceExport: boolean
  enforceRetention: boolean
}

function emptyDraft(): Draft {
  return {
    isNew: true,
    module: "",
    entity: "",
    field: "",
    level: "Internal",
    enforceAccess: false,
    enforceExport: true,
    enforceRetention: false,
  }
}

export function ClassificationEditor() {
  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(API, fetcher)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<Mapping | null>(null)
  const [saving, setSaving] = useState(false)

  const mappings = data?.mappings ?? []
  const clearance = data?.clearance

  async function save() {
    if (!editing) return
    if (!editing.module.trim() || !editing.entity.trim() || !editing.field.trim()) {
      toast.error("Module, entity and field are all required.")
      return
    }
    setSaving(true)
    try {
      const payload = {
        module: editing.module.trim(),
        entity: editing.entity.trim(),
        field: editing.field.trim(),
        level: editing.level,
        enforceAccess: editing.enforceAccess,
        enforceExport: editing.enforceExport,
        enforceRetention: editing.enforceRetention,
      }
      const res = await fetch(editing.isNew ? API : `${API}/${editing.id}`, {
        method: editing.isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not save classification")
      }
      toast.success(editing.isNew ? "Classification added." : "Classification updated.")
      setEditing(null)
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
        throw new Error(body.error || "Could not delete classification")
      }
      toast.success("Classification removed.")
      setDeleting(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function updateClearance(next: ClearanceMatrix) {
    // Optimistic — reflect immediately, roll back on failure.
    mutate({ mappings, clearance: next } as ApiResponse, false)
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearance: next }),
      })
      if (!res.ok) throw new Error("Could not update clearance matrix")
      toast.success("Clearance matrix updated.")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
      mutate()
    }
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-5">
        {LEVELS.map((l) => (
          <Card key={l.level}>
            <CardContent className="flex flex-col gap-1.5 pt-4">
              <Badge variant={l.tone} className="w-fit text-[10px]">
                {l.level}
              </Badge>
              <p className="text-xs text-muted-foreground">{l.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Clearance matrix — the configurable policy that turns a level into a
          minimum role for access/export and an auto-delete decision. */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            Clearance matrix
          </CardTitle>
          <CardDescription>
            Sets the minimum role required to access and export each level, and whether records at that level may be
            auto-deleted by retention. Enforcement applies wherever a classification has the matching toggle enabled.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Level</TableHead>
                <TableHead>Min role to access</TableHead>
                <TableHead>Min role to export</TableHead>
                <TableHead>Auto-delete allowed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading || !clearance
                ? Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={4}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : CLASSIFICATION_LEVELS.map((level) => {
                    const rule = clearance[level]
                    return (
                      <TableRow key={level}>
                        <TableCell>
                          <Badge variant={levelTone(level)} className="text-[10px]">
                            {level}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={rule.accessMinRole}
                            onValueChange={(v) =>
                              updateClearance({
                                ...clearance,
                                [level]: { ...rule, accessMinRole: v as (typeof rule)["accessMinRole"] },
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-[160px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TENANT_ROLE_OPTIONS.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={rule.exportMinRole}
                            onValueChange={(v) =>
                              updateClearance({
                                ...clearance,
                                [level]: { ...rule, exportMinRole: v as (typeof rule)["exportMinRole"] },
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-[160px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TENANT_ROLE_OPTIONS.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={rule.allowAutoDelete}
                            onCheckedChange={(checked) =>
                              updateClearance({
                                ...clearance,
                                [level]: { ...rule, allowAutoDelete: checked },
                              })
                            }
                            aria-label={`Allow auto-delete for ${level}`}
                          />
                        </TableCell>
                      </TableRow>
                    )
                  })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Tag className="size-4 text-muted-foreground" />
              Classification mappings
            </CardTitle>
            <CardDescription>
              Maps a module / entity / field to a sensitivity level and controls where that classification is enforced.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setEditing(emptyDraft())}>
            <Plus className="size-3.5" />
            New mapping
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
                  <TableHead>Entity</TableHead>
                  <TableHead>Field</TableHead>
                  <TableHead>Classification</TableHead>
                  <TableHead>Enforcement</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : mappings.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      No classifications yet. Add one to start enforcing sensitivity levels.
                    </TableCell>
                  </TableRow>
                ) : (
                  mappings.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {m.module}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{m.entity}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{m.field}</TableCell>
                      <TableCell>
                        <Badge variant={levelTone(m.level)} className="text-[10px]">
                          {m.level}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {m.enforceAccess && (
                            <Badge variant="secondary" className="text-[10px]">
                              Access
                            </Badge>
                          )}
                          {m.enforceExport && (
                            <Badge variant="secondary" className="text-[10px]">
                              Export
                            </Badge>
                          )}
                          {m.enforceRetention && (
                            <Badge variant="secondary" className="text-[10px]">
                              Retention
                            </Badge>
                          )}
                          {!m.enforceAccess && !m.enforceExport && !m.enforceRetention && (
                            <span className="text-xs text-muted-foreground">Label only</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${m.field}`}
                            onClick={() => setEditing({ ...m, isNew: false })}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${m.field}`}
                            onClick={() => setDeleting(m)}
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

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? "New mapping" : "Edit mapping"}</DialogTitle>
            <DialogDescription>Assign a sensitivity level and choose where it is enforced.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="cm-module">Module</Label>
                <Input
                  id="cm-module"
                  value={editing.module}
                  onChange={(e) => setEditing({ ...editing, module: e.target.value })}
                  placeholder="e.g. HR"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cm-entity">Entity</Label>
                <Input
                  id="cm-entity"
                  value={editing.entity}
                  onChange={(e) => setEditing({ ...editing, entity: e.target.value })}
                  placeholder="e.g. Employee"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cm-field">Field</Label>
                <Input
                  id="cm-field"
                  value={editing.field}
                  onChange={(e) => setEditing({ ...editing, field: e.target.value })}
                  placeholder="e.g. bank_account_number"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cm-level">Classification</Label>
                <Select
                  value={editing.level}
                  onValueChange={(v) => setEditing({ ...editing, level: v as ClassificationLevel })}
                >
                  <SelectTrigger id="cm-level" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLASSIFICATION_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">Enforce this classification for</p>
                <div className="flex items-center justify-between">
                  <Label htmlFor="cm-access" className="text-sm font-normal">
                    Access (gate reads by clearance)
                  </Label>
                  <Switch
                    id="cm-access"
                    checked={editing.enforceAccess}
                    onCheckedChange={(checked) => setEditing({ ...editing, enforceAccess: checked })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="cm-export" className="text-sm font-normal">
                    Export (redact for under-cleared roles)
                  </Label>
                  <Switch
                    id="cm-export"
                    checked={editing.enforceExport}
                    onCheckedChange={(checked) => setEditing({ ...editing, enforceExport: checked })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="cm-retention" className="text-sm font-normal">
                    Retention (block auto-delete when disallowed)
                  </Label>
                  <Switch
                    id="cm-retention"
                    checked={editing.enforceRetention}
                    onCheckedChange={(checked) => setEditing({ ...editing, enforceRetention: checked })}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save mapping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mapping?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the classification for {deleting?.module} / {deleting?.entity} / {deleting?.field}. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
