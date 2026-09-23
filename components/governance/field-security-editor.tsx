"use client"

import { useState } from "react"
import useSWR from "swr"
import { Eye, EyeOff, Lock, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react"
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

const API = "/api/admin/governance/field-security"

const TENANT_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "employee", label: "Employee" },
  { value: "module_admin", label: "Module Admin" },
  { value: "tenant_admin", label: "Tenant Admin" },
  { value: "tenant_owner", label: "Tenant Owner" },
]

const EFFECT_META: Record<string, { label: string; description: string; tone: "secondary" | "outline" | "destructive"; icon: typeof Eye }> = {
  visible: { label: "Visible", description: "No restriction.", tone: "secondary", icon: Eye },
  read_only: { label: "Read only", description: "Shown but not editable.", tone: "outline", icon: Lock },
  masked: { label: "Masked", description: "Value obscured (last digits may remain).", tone: "outline", icon: ShieldAlert },
  hidden: { label: "Hidden", description: "Removed from responses entirely.", tone: "destructive", icon: EyeOff },
}

type CatalogEntry = { value: string; label: string; description?: string; hint?: string }
type Catalog = {
  categories: CatalogEntry[]
  effects: string[]
  scopeTypes: CatalogEntry[]
}

type Policy = {
  id: number
  module: string
  entity: string
  field: string
  category: string
  scopeType: string
  scopeValue: string
  effect: string
  enabled: boolean
  createdByName: string | null
}

type ApiResponse = { policies: Policy[]; catalog: Catalog }

type Draft = {
  id?: number
  isNew: boolean
  module: string
  entity: string
  field: string
  category: string
  scopeType: string
  scopeValue: string
  effect: string
  enabled: boolean
}

function emptyDraft(): Draft {
  return {
    isNew: true,
    module: "",
    entity: "",
    field: "",
    category: "generic",
    scopeType: "role",
    scopeValue: "employee",
    effect: "masked",
    enabled: true,
  }
}

function effectTone(effect: string): "secondary" | "outline" | "destructive" {
  return EFFECT_META[effect]?.tone ?? "outline"
}

export function FieldSecurityEditor() {
  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(API, fetcher)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<Policy | null>(null)
  const [saving, setSaving] = useState(false)

  const policies = data?.policies ?? []
  const catalog = data?.catalog
  const categories = catalog?.categories ?? []
  const scopeTypes = catalog?.scopeTypes ?? []
  const effects = catalog?.effects ?? ["visible", "read_only", "masked", "hidden"]

  const scopeNeedsValue = editing ? editing.scopeType !== "everyone" : false
  const scopeIsRole = editing?.scopeType === "role"

  function scopeSummary(p: Policy): string {
    const meta = scopeTypes.find((s) => s.value === p.scopeType)
    if (p.scopeType === "everyone") return "Everyone"
    if (p.scopeType === "role") {
      const role = TENANT_ROLE_OPTIONS.find((r) => r.value === p.scopeValue)?.label ?? p.scopeValue
      return `${role} & below`
    }
    return `${meta?.label ?? p.scopeType}: ${p.scopeValue}`
  }

  function categoryLabel(value: string): string {
    return categories.find((c) => c.value === value)?.label ?? value
  }

  async function save() {
    if (!editing) return
    if (!editing.module.trim() || !editing.entity.trim() || !editing.field.trim()) {
      toast.error("Module, entity and field are all required.")
      return
    }
    if (editing.scopeType !== "everyone" && !editing.scopeValue.trim()) {
      toast.error("This scope needs a value (or switch the scope to Everyone).")
      return
    }
    setSaving(true)
    try {
      const payload = {
        module: editing.module.trim(),
        entity: editing.entity.trim(),
        field: editing.field.trim(),
        category: editing.category,
        scopeType: editing.scopeType,
        scopeValue: editing.scopeType === "everyone" ? "" : editing.scopeValue.trim(),
        effect: editing.effect,
        enabled: editing.enabled,
      }
      const res = await fetch(editing.isNew ? API : `${API}/${editing.id}`, {
        method: editing.isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not save policy")
      }
      toast.success(editing.isNew ? "Field policy added." : "Field policy updated.")
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
        throw new Error(body.error || "Could not delete policy")
      }
      toast.success("Field policy removed.")
      setDeleting(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <>
      {/* Sensitive-field catalog — the categories the framework knows how to
          mask, so admins pick the right masking strategy per field. */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" />
            Sensitive field categories
          </CardTitle>
          <CardDescription>
            Each category has a masking strategy tuned to its data — account numbers reveal only their last digits,
            while salaries and internal financials are fully obscured. Enforcement is applied server-side to API
            responses, exports, and reports; never as frontend-only masking.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
            : categories.map((c) => (
                <div key={c.value} className="flex flex-col gap-1 rounded-md border p-3">
                  <Badge variant="outline" className="w-fit text-[10px]">
                    {c.label}
                  </Badge>
                  <p className="text-xs text-muted-foreground">{c.description}</p>
                </div>
              ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" />
              Field-level policies
            </CardTitle>
            <CardDescription>
              Restrict a specific field for a defined audience. Multiple policies can target one field; the most
              restrictive effect always wins.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setEditing(emptyDraft())}>
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
                  <TableHead>Field</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Applies to</TableHead>
                  <TableHead>Effect</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : policies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      No field policies yet. Add one to start restricting sensitive fields.
                    </TableCell>
                  </TableRow>
                ) : (
                  policies.map((p) => {
                    const EffectIcon = EFFECT_META[p.effect]?.icon ?? ShieldAlert
                    return (
                      <TableRow key={p.id} className={p.enabled ? undefined : "opacity-55"}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{p.field}</span>
                            <span className="text-xs text-muted-foreground">
                              {p.module} · {p.entity}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {categoryLabel(p.category)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{scopeSummary(p)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={effectTone(p.effect)} className="gap-1 text-[10px]">
                              <EffectIcon className="size-3" />
                              {EFFECT_META[p.effect]?.label ?? p.effect}
                            </Badge>
                            {!p.enabled && (
                              <Badge variant="secondary" className="text-[10px]">
                                Disabled
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit policy for ${p.field}`}
                              onClick={() => setEditing({ ...p, isNew: false })}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete policy for ${p.field}`}
                              onClick={() => setDeleting(p)}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? "New field policy" : "Edit field policy"}</DialogTitle>
            <DialogDescription>Restrict a sensitive field for a defined audience.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="fs-module">Module</Label>
                  <Input
                    id="fs-module"
                    value={editing.module}
                    onChange={(e) => setEditing({ ...editing, module: e.target.value })}
                    placeholder="e.g. HR"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="fs-entity">Entity</Label>
                  <Input
                    id="fs-entity"
                    value={editing.entity}
                    onChange={(e) => setEditing({ ...editing, entity: e.target.value })}
                    placeholder="e.g. Employee"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-field">Field (column name)</Label>
                <Input
                  id="fs-field"
                  value={editing.field}
                  onChange={(e) => setEditing({ ...editing, field: e.target.value })}
                  placeholder="e.g. bank_account_number"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-category">Sensitive category</Label>
                <Select value={editing.category} onValueChange={(v) => setEditing({ ...editing, category: v })}>
                  <SelectTrigger id="fs-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="fs-scope-type">Applies to</Label>
                  <Select
                    value={editing.scopeType}
                    onValueChange={(v) =>
                      setEditing({ ...editing, scopeType: v, scopeValue: v === "role" ? "employee" : "" })
                    }
                  >
                    <SelectTrigger id="fs-scope-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scopeTypes.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="fs-scope-value">Scope value</Label>
                  {scopeIsRole ? (
                    <Select value={editing.scopeValue} onValueChange={(v) => setEditing({ ...editing, scopeValue: v })}>
                      <SelectTrigger id="fs-scope-value" className="w-full">
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
                  ) : (
                    <Input
                      id="fs-scope-value"
                      value={editing.scopeValue}
                      disabled={!scopeNeedsValue}
                      onChange={(e) => setEditing({ ...editing, scopeValue: e.target.value })}
                      placeholder={scopeNeedsValue ? "e.g. Finance" : "—"}
                    />
                  )}
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fs-effect">Effect</Label>
                <Select value={editing.effect} onValueChange={(v) => setEditing({ ...editing, effect: v })}>
                  <SelectTrigger id="fs-effect" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {effects.map((eff) => (
                      <SelectItem key={eff} value={eff}>
                        {EFFECT_META[eff]?.label ?? eff}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{EFFECT_META[editing.effect]?.description}</p>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="fs-enabled" className="text-sm font-normal">
                  Policy enabled
                </Label>
                <Switch
                  id="fs-enabled"
                  checked={editing.enabled}
                  onCheckedChange={(checked) => setEditing({ ...editing, enabled: checked })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete field policy?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `The "${deleting.field}" restriction for ${scopeSummary(deleting)} will be removed. This field will no longer be masked or hidden for that audience.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
