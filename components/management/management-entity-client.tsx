"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react"
import { statusField, type EntityDef, type FieldDef } from "@/lib/management-entities"

type Row = Record<string, any>
type ListResponse = { rows: Row[]; total: number }

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function emptyForm(entity: EntityDef): Record<string, string> {
  const form: Record<string, string> = {}
  for (const f of entity.fields) form[f.name] = ""
  return form
}

function toForm(entity: EntityDef, row: Row): Record<string, string> {
  const form: Record<string, string> = {}
  for (const f of entity.fields) {
    const v = row[f.name]
    form[f.name] = v == null ? "" : String(v)
  }
  return form
}

function statusVariant(value: string): "default" | "secondary" | "destructive" | "outline" {
  const v = value.toLowerCase()
  if (["active", "valid"].includes(v)) return "default"
  if (["expired", "revoked", "cancelled", "terminated", "suspended"].includes(v)) return "destructive"
  if (["draft", "pending", "inactive", "archived", "maintenance", "closed", "retired"].includes(v)) return "secondary"
  return "outline"
}

function formatCell(field: FieldDef, value: any): React.ReactNode {
  if (value == null || value === "") return <span className="text-muted-foreground">—</span>
  if (field.name === "status") {
    return <Badge variant={statusVariant(String(value))}>{String(value)}</Badge>
  }
  if (field.type === "number") {
    const n = Number(value)
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2 })
  }
  return String(value)
}

export function ManagementEntityClient({ entity }: { entity: EntityDef }) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Record<string, string>>(() => emptyForm(entity))
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null)

  const statusFd = statusField(entity)
  const tableFields = useMemo(() => entity.fields.filter((f) => f.inTable), [entity])

  const params = new URLSearchParams()
  if (search.trim()) params.set("search", search.trim())
  if (status !== "all") params.set("status", status)
  const listKey = `/api/management/${entity.key}?${params.toString()}`

  const { data, isLoading, mutate } = useSWR<ListResponse>(listKey, fetcher, {
    keepPreviousData: true,
  })
  const rows = data?.rows ?? []

  function openCreate() {
    setEditing(null)
    setForm(emptyForm(entity))
    setDialogOpen(true)
  }

  function openEdit(row: Row) {
    setEditing(row)
    setForm(toForm(entity, row))
    setDialogOpen(true)
  }

  async function submit() {
    for (const f of entity.fields) {
      if (f.required && !form[f.name]?.trim()) {
        toast.error(`${f.label} is required.`)
        return
      }
    }
    setSaving(true)
    try {
      const url = editing
        ? `/api/management/${entity.key}/${encodeURIComponent(editing.record_id)}`
        : `/api/management/${entity.key}`
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || "Request failed")
      toast.success(editing ? `${entity.label} updated.` : `${entity.label} created.`)
      setDialogOpen(false)
      mutate()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      const res = await fetch(
        `/api/management/${entity.key}/${encodeURIComponent(deleteTarget.record_id)}`,
        { method: "DELETE" },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || "Delete failed")
      toast.success("Record deleted.")
      mutate()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{entity.title}</h1>
        <p className="text-sm text-muted-foreground">{entity.description}</p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${entity.title.toLowerCase()}...`}
              className="pl-8"
            />
          </div>
          {statusFd?.options?.length ? (
            <Select value={status} onValueChange={(v) => setStatus(v ?? "all")}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusFd.options.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => mutate()} aria-label="Refresh">
            <RefreshCw className="size-4" />
          </Button>
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Add {entity.label.replace(/s$/, "")}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">ID</TableHead>
                  {tableFields.map((f) => (
                    <TableHead key={f.name} className="whitespace-nowrap">
                      {f.label}
                    </TableHead>
                  ))}
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={tableFields.length + 2} className="h-24 text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={tableFields.length + 2} className="h-24 text-center text-muted-foreground">
                      No records yet. Click &quot;Add&quot; to create the first one.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.record_id}>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {row.record_id}
                      </TableCell>
                      {tableFields.map((f) => (
                        <TableCell key={f.name} className="whitespace-nowrap">
                          {formatCell(f, row[f.name])}
                        </TableCell>
                      ))}
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(row)} aria-label="Edit">
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteTarget(row)}
                            aria-label="Delete"
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
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {rows.length} {rows.length === 1 ? "record" : "records"}
      </p>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${entity.label.replace(/s$/, "")}` : `Add ${entity.label.replace(/s$/, "")}`}
            </DialogTitle>
            <DialogDescription>{entity.description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2 sm:grid-cols-2">
            {entity.fields.map((f) => (
              <div
                key={f.name}
                className={`flex flex-col gap-1.5 ${f.type === "textarea" ? "sm:col-span-2" : ""}`}
              >
                <Label htmlFor={`field-${f.name}`}>
                  {f.label}
                  {f.required ? <span className="text-destructive"> *</span> : null}
                </Label>
                {f.type === "textarea" ? (
                  <Textarea
                    id={`field-${f.name}`}
                    value={form[f.name] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [f.name]: e.target.value }))}
                    placeholder={f.placeholder}
                    rows={3}
                  />
                ) : f.type === "select" ? (
                  <Select
                    value={form[f.name] || ""}
                    onValueChange={(v) => setForm((s) => ({ ...s, [f.name]: v ?? "" }))}
                  >
                    <SelectTrigger id={`field-${f.name}`}>
                      <SelectValue placeholder={`Select ${f.label.toLowerCase()}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {(f.options ?? []).map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`field-${f.name}`}
                    type={f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "email" ? "email" : "text"}
                    value={form[f.name] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [f.name]: e.target.value }))}
                    placeholder={f.placeholder}
                  />
                )}
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving..." : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {deleteTarget?.record_id}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
