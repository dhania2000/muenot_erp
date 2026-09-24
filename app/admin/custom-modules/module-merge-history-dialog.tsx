"use client"

import { useState } from "react"
import useSWR from "swr"
import { AlertCircle, History, Undo2 } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { ModuleDefinition } from "@/lib/custom-modules/model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

type MergeHistoryEntry = {
  id: number
  primaryId: number
  secondaryIds: number[]
  referenceChanges: number
  status: "merged" | "rolled_back"
  createdAt: string
  rolledBackAt: string | null
}

export function ModuleMergeHistoryDialog({
  module,
  onClose,
  onChanged,
}: {
  module: ModuleDefinition
  onClose: () => void
  onChanged: () => void
}) {
  const key = `/api/custom-modules/${module.slug}/records/merge`
  const { data, error, isLoading, mutate } = useSWR<{ merges: MergeHistoryEntry[] }>(key, fetcher)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const merges = data?.merges ?? []

  async function rollback(entry: MergeHistoryEntry) {
    if (!window.confirm(`Roll back this merge? Retired records will be restored.`)) return
    setBusyId(entry.id)
    setActionError(null)
    try {
      const res = await fetch(`/api/custom-modules/${module.slug}/records/merge/${entry.id}`, {
        method: "POST",
      })
      if (res.ok) {
        await mutate()
        onChanged()
      } else {
        const body = await res.json().catch(() => null)
        setActionError(body?.error ?? "Rollback failed.")
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Merge history
          </DialogTitle>
          <DialogDescription>
            Every merge for {module.pluralName || module.name}. Roll one back to restore the retired
            records and undo the reference repoints.
          </DialogDescription>
        </DialogHeader>

        {actionError && (
          <Card className="flex items-center gap-2 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span>{actionError}</span>
          </Card>
        )}

        {error ? (
          <Card className="p-6 text-sm text-muted-foreground">Failed to load the merge history.</Card>
        ) : isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : merges.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">No merges yet.</Card>
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-2 overflow-auto">
            {merges.map((entry) => (
              <Card key={entry.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 text-sm">
                  <div className="font-medium">
                    Merged into #{entry.primaryId}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {entry.secondaryIds.length} record{entry.secondaryIds.length === 1 ? "" : "s"} retired
                      {entry.referenceChanges > 0 && ` · ${entry.referenceChanges} refs`}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">{entry.createdAt}</div>
                </div>
                {entry.status === "rolled_back" ? (
                  <Badge variant="outline">Rolled back</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === entry.id}
                    onClick={() => rollback(entry)}
                  >
                    <Undo2 className="mr-1 h-3.5 w-3.5" />
                    Roll back
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
