"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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

type Id = number

/** Tracks which table rows are checked. Ids are the row primary keys. */
export function useRowSelection() {
  const [selected, setSelected] = useState<Set<Id>>(new Set())

  const toggle = useCallback((id: Id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((ids: Id[], checked: boolean) => {
    setSelected(checked ? new Set(ids) : new Set())
  }, [])

  const clear = useCallback(() => setSelected(new Set()), [])

  return { selected, toggle, toggleAll, clear }
}

type Pending =
  | { kind: "single"; id: Id; label: string }
  | { kind: "bulk"; ids: Id[] }
  | null

type Labels = { singular: string; plural: string }

/**
 * Manages the delete confirmation flow for a table. Both single-row and
 * bulk deletes funnel through the same styled warning dialog, and bulk
 * deletes fan out to the existing per-id DELETE endpoint in parallel.
 */
export function useDeleteManager({
  endpoint,
  labels,
  mutate,
  onDeleted,
}: {
  endpoint: (id: Id) => string
  labels: Labels
  mutate: () => void | Promise<unknown>
  onDeleted?: () => void
}) {
  const [pending, setPending] = useState<Pending>(null)
  const [loading, setLoading] = useState(false)

  const requestSingle = useCallback((id: Id, label: string) => {
    setPending({ kind: "single", id, label })
  }, [])

  const requestBulk = useCallback((ids: Id[]) => {
    if (ids.length > 0) setPending({ kind: "bulk", ids })
  }, [])

  const cancel = useCallback(() => {
    if (!loading) setPending(null)
  }, [loading])

  const confirm = useCallback(async () => {
    if (!pending) return
    const ids = pending.kind === "single" ? [pending.id] : pending.ids
    setLoading(true)
    try {
      const results = await Promise.all(ids.map((id) => fetch(endpoint(id), { method: "DELETE" })))
      const failed = results.filter((r) => !r.ok).length
      const noun = ids.length === 1 ? labels.singular : labels.plural
      if (failed === 0) {
        toast.success(ids.length === 1 ? `${labels.singular} deleted` : `${ids.length} ${labels.plural} deleted`)
      } else if (failed < ids.length) {
        toast.warning(`Deleted ${ids.length - failed} of ${ids.length} ${labels.plural}; ${failed} failed`)
      } else {
        toast.error(`Unable to delete ${noun}`)
      }
      await mutate()
      onDeleted?.()
    } catch {
      toast.error("Something went wrong while deleting")
    } finally {
      setLoading(false)
      setPending(null)
    }
  }, [pending, endpoint, labels, mutate, onDeleted])

  const count = pending?.kind === "bulk" ? pending.ids.length : pending ? 1 : 0
  const title =
    pending?.kind === "bulk"
      ? `Delete ${count} ${labels.plural}?`
      : `Delete this ${labels.singular}?`
  const description =
    pending?.kind === "bulk"
      ? `This will permanently delete ${count} selected ${labels.plural}. This action cannot be undone.`
      : pending?.kind === "single"
        ? `This will permanently delete ${pending.label}. This action cannot be undone.`
        : ""

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && cancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <AlertTriangle className="size-5" />
            </span>
            <div className="flex flex-col gap-1 text-left">
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            disabled={loading}
            onClick={(event) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {loading ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <Trash2 data-icon="inline-start" />
            )}
            {pending?.kind === "bulk" ? `Delete ${count}` : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { requestSingle, requestBulk, confirm, cancel, loading, dialog }
}

/** Header checkbox that selects/clears every currently visible row. */
export function SelectAllCheckbox({
  ids,
  selected,
  onToggleAll,
}: {
  ids: Id[]
  selected: Set<Id>
  onToggleAll: (ids: Id[], checked: boolean) => void
}) {
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
  return (
    <Checkbox
      aria-label="Select all rows"
      checked={allSelected}
      disabled={ids.length === 0}
      onCheckedChange={(checked) => onToggleAll(ids, checked === true)}
    />
  )
}

/** Sticky action bar shown while one or more rows are selected. */
export function SelectionToolbar({
  count,
  noun,
  onClear,
  onDelete,
}: {
  count: number
  noun: string
  onClear: () => void
  onDelete: () => void
}) {
  if (count === 0) return null
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5">
      <span className="text-sm font-medium">
        {count} {count === 1 ? noun : `${noun}s`} selected
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X data-icon="inline-start" />
          Clear
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 data-icon="inline-start" />
          Delete selected
        </Button>
      </div>
    </div>
  )
}
