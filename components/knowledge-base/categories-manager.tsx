"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { type Category } from "./kb-lib"
import { Folder, Plus, Pencil, Trash2, Check, X, Loader2 } from "lucide-react"

export function CategoriesManager() {
  const { data, mutate, isLoading } = useSWR<{ categories: Category[] }>("/api/knowledge-base/categories", fetcher)
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)

  const categories = data?.categories ?? []

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    const res = await fetch("/api/knowledge-base/categories", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    })
    const body = await res.json()
    setCreating(false)
    if (!res.ok) return toast.error(body.error || "Could not create category")
    toast.success("Category created")
    setNewName("")
    mutate()
  }

  const patch = async (id: number, patch: Record<string, unknown>) => {
    const res = await fetch("/api/knowledge-base/categories", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }),
    })
    const body = await res.json()
    if (!res.ok) return toast.error(body.error || "Update failed")
    mutate()
  }

  const saveRename = async () => {
    if (editId == null) return
    if (!editName.trim()) return toast.error("Name cannot be empty")
    await patch(editId, { name: editName.trim() })
    toast.success("Category renamed")
    setEditId(null)
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    const res = await fetch(`/api/knowledge-base/categories?id=${deleteTarget.id}`, { method: "DELETE" })
    const body = await res.json()
    if (!res.ok) {
      toast.error(body.error || "Delete failed")
      if (body.code === "in_use") await patch(deleteTarget.id, { active: false })
    } else {
      toast.success("Category deleted")
      mutate()
    }
    setDeleteTarget(null)
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      <div className="flex items-end gap-2 rounded-lg border bg-card p-4">
        <label className="grid flex-1 gap-1.5 text-sm font-medium">
          New category
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) create() }}
            placeholder="e.g. Human Resources"
          />
        </label>
        <Button onClick={create} disabled={creating}>
          {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Categories</h2>
          <span className="text-xs text-muted-foreground">{categories.length} total</span>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : categories.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            <Folder className="size-8" /> No categories yet.
          </div>
        ) : (
          <ul>
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-0">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                {editId === c.id ? (
                  <>
                    <Input
                      autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) saveRename(); if (e.key === "Escape") setEditId(null) }}
                      className="h-8 flex-1"
                    />
                    <Button size="icon" variant="ghost" onClick={saveRename} aria-label="Save"><Check className="size-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditId(null)} aria-label="Cancel"><X className="size-4" /></Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 font-medium">{c.name}</span>
                    <Badge variant="secondary" className="font-normal">{c.article_count ?? 0} article{c.article_count === 1 ? "" : "s"}</Badge>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox checked={!!c.active} onCheckedChange={(v) => patch(c.id, { active: !!v })} /> Active
                    </label>
                    <Button size="icon" variant="ghost" onClick={() => { setEditId(c.id); setEditName(c.name) }} aria-label="Rename"><Pencil className="size-3.5" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(c)} aria-label="Delete"><Trash2 className="size-3.5" /></Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.article_count
                ? "This category is in use. It will be deactivated instead of deleted so existing article links stay intact."
                : "This category will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>{deleteTarget?.article_count ? "Deactivate" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
