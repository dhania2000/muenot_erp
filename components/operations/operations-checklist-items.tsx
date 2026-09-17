"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { ListChecks, Plus, Trash2 } from "lucide-react"

const ITEM_STATUSES = ["Pending", "Completed", "Not Applicable"] as const

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Completed: "default",
  Pending: "secondary",
  "Not Applicable": "outline",
}

/**
 * Manage the items behind a configurable checklist (Phases 34-35). Adding,
 * updating status, or deleting an item recomputes the parent checklist's
 * completion % automatically on the server, so the list row stays in sync.
 */
export function OperationsChecklistItems({
  checklistId,
  name,
  onChange,
}: {
  checklistId: number | string
  name?: string
  onChange?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [newItem, setNewItem] = useState("")
  const [busy, setBusy] = useState(false)
  const key = open ? `/api/operations/checklist-items?checklist_id=${encodeURIComponent(String(checklistId))}` : null
  const { data, mutate, isLoading } = useSWR<{ rows: any[] }>(key, fetcher)
  const rows = data?.rows ?? []

  const applicable = rows.filter((r) => String(r.item_status).toLowerCase() !== "not applicable").length
  const completed = rows.filter((r) => String(r.item_status).toLowerCase() === "completed").length
  const percent = applicable > 0 ? Math.round((completed / applicable) * 100) : 0

  function refresh() {
    mutate()
    onChange?.()
  }

  async function addItem() {
    const text = newItem.trim()
    if (!text) return
    setBusy(true)
    try {
      await fetch("/api/operations/checklist-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checklist_id: checklistId, item_text: text }),
      })
      setNewItem("")
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(id: number, item_status: string) {
    await fetch("/api/operations/checklist-items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, item_status }),
    })
    refresh()
  }

  async function remove(id: number) {
    await fetch(`/api/operations/checklist-items?id=${id}`, { method: "DELETE" })
    refresh()
  }

  return (
    <>
      <Button size="sm" variant="ghost" aria-label="Manage checklist items" onClick={() => setOpen(true)}>
        <ListChecks className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Checklist Items{name ? ` — ${name}` : ""}</DialogTitle>
            <DialogDescription>
              {completed} of {applicable} applicable items complete · {percent}% done. Completion is recalculated
              automatically. &quot;Not Applicable&quot; items are excluded from the total.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Input
              placeholder="Add a checklist item…"
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  addItem()
                }
              }}
            />
            <Button onClick={addItem} disabled={busy || !newItem.trim()}>
              <Plus className="size-4" />
              Add
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Completed By</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="p-6 text-center text-muted-foreground">
                    Loading items…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="p-6 text-center text-muted-foreground">
                    No items yet. Add the first item above.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.item_text}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANT[String(r.item_status)] ?? "outline"}>{r.item_status}</Badge>
                      <select
                        aria-label="Change item status"
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        value={r.item_status}
                        onChange={(e) => setStatus(r.id, e.target.value)}
                      >
                        {ITEM_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.completed_by ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Delete item"
                      className="text-destructive hover:text-destructive"
                      onClick={() => remove(r.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </>
  )
}
