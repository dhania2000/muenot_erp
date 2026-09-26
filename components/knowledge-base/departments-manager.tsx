"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { type ArticleRow } from "./kb-lib"
import { Building2, Plus, Pencil, Trash2, Check, X, Loader2 } from "lucide-react"

type Department = { department_id: string; department_name: string; status?: string | null }

const isComposing = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229

// Departments are owned by the HR master (hr_departments); the Knowledge Base
// reuses that register instead of keeping its own copy. The HR master API
// enforces permission, duplicate checks, audit, and dependency-aware delete.
export function DepartmentsManager({
  articles = [], onOpen,
}: { articles?: ArticleRow[]; onOpen?: (id: number) => void }) {
  const { data, mutate, isLoading } = useSWR<{ rows: Department[] }>("/api/hr/master-data?kind=departments", fetcher)
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null)

  const departments = useMemo(
    () => [...(data?.rows ?? [])].sort((a, b) => a.department_name.localeCompare(b.department_name)),
    [data],
  )
  const articlesByDept = useMemo(() => {
    const map = new Map<string, ArticleRow[]>()
    for (const a of articles) {
      if (!a.department) continue
      if (!map.has(a.department)) map.set(a.department, [])
      map.get(a.department)!.push(a)
    }
    return map
  }, [articles])

  const send = async (method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, qs = "") => {
    const res = await fetch(`/api/hr/master-data${qs}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, json }
  }

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    const { ok, json } = await send("POST", { kind: "departments", department_name: name, status: "Active" })
    setBusy(false)
    if (!ok) return toast.error(json.error || "Could not add department")
    toast.success("Department added")
    setNewName("")
    mutate()
  }

  const saveRename = async () => {
    if (!editId) return
    const name = editName.trim()
    if (!name) return toast.error("Name cannot be empty")
    const { ok, json } = await send("PATCH", { kind: "departments", id: editId, department_name: name })
    if (!ok) return toast.error(json.error || "Update failed")
    toast.success("Department updated")
    setEditId(null)
    mutate()
  }

  const toggleActive = async (d: Department) => {
    const next = d.status === "Inactive" ? "Active" : "Inactive"
    const { ok, json } = await send("PATCH", { kind: "departments", id: d.department_id, status: next })
    if (!ok) return toast.error(json.error || "Update failed")
    mutate()
  }

  const doDelete = async () => {
    const target = deleteTarget
    if (!target) return
    const { ok, json } = await send(
      "DELETE", undefined, `?kind=departments&id=${encodeURIComponent(target.department_id)}`,
    )
    setDeleteTarget(null)
    if (!ok) return toast.error(json.error || "Could not remove department")
    toast.success(json.deactivated ? "Department is in use, so it was deactivated" : "Department removed")
    mutate()
  }

  return (
    <div className="grid w-full gap-4">
      <div className="flex items-end gap-2 rounded-lg border bg-card p-4">
        <label className="grid flex-1 gap-1.5 text-sm font-medium">
          New department
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !isComposing(e)) create() }}
            placeholder="e.g. Human Resources"
          />
        </label>
        <Button onClick={create} disabled={busy || !newName.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Departments</h2>
          <span className="text-xs text-muted-foreground">{departments.length} total</span>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : departments.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            <Building2 className="size-8" /> No departments yet.
          </div>
        ) : (
          <ul className="divide-y">
            {departments.map((d) => {
              const items = articlesByDept.get(d.department_name) ?? []
              const inactive = d.status === "Inactive"
              return (
                <li key={d.department_id} className="grid gap-2 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    {editId === d.department_id ? (
                      <>
                        <Input
                          autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !isComposing(e)) saveRename()
                            if (e.key === "Escape") setEditId(null)
                          }}
                          className="h-8 flex-1"
                          aria-label="Department name"
                        />
                        <Button size="icon" variant="ghost" onClick={saveRename} aria-label="Save"><Check className="size-4" /></Button>
                        <Button size="icon" variant="ghost" onClick={() => setEditId(null)} aria-label="Cancel"><X className="size-4" /></Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 truncate font-medium">{d.department_name}</span>
                        <Badge variant="secondary" className="font-normal">{items.length} item{items.length === 1 ? "" : "s"}</Badge>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => toggleActive(d)}>
                          {inactive ? "Inactive" : "Active"}
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => { setEditId(d.department_id); setEditName(d.department_name) }} aria-label={`Edit ${d.department_name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(d)} aria-label={`Remove ${d.department_name}`}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                  {onOpen && items.length > 0 && (
                    <ul className="grid gap-1 pl-7">
                      {items.slice(0, 5).map((a) => (
                        <li key={a.id}>
                          <button onClick={() => onOpen(a.id)} className="w-full truncate text-left text-sm text-muted-foreground hover:text-foreground">
                            {a.heading}
                          </button>
                        </li>
                      ))}
                      {items.length > 5 && <li className="text-xs text-muted-foreground">+{items.length - 5} more</li>}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{deleteTarget?.department_name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              If employees or other records still use this department, it will be deactivated instead of deleted so history stays intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
