"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, GitMerge, Paperclip, Link2, Crown } from "lucide-react"
import type { ModuleDefinition, ModuleField } from "@/lib/custom-modules/model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type MergeRecord = {
  id: number
  state: string | null
  values: Record<string, unknown>
}

type FieldChoice = {
  key: string
  label: string
  type: string
  computed: boolean
  source: string
  value: unknown
}

type Preview = {
  primaryId: number
  secondaryIds: number[]
  fields: FieldChoice[]
  attachmentCount: number
  referenceChanges: number
}

function formatValue(field: ModuleField | undefined, raw: unknown): string {
  if (raw == null || raw === "") return "—"
  if (typeof raw === "boolean") return raw ? "Yes" : "No"
  if (Array.isArray(raw)) return raw.length ? raw.map(String).join(", ") : "—"
  if (typeof raw === "object") {
    const amount = (raw as any).amount
    if (amount != null) return `${(raw as any).currency ?? ""} ${amount}`.trim()
    const id = (raw as any).id
    if (id != null) return `#${id}`
    return JSON.stringify(raw)
  }
  if (field && (field.type === "dropdown" || field.type === "multiselect")) {
    const opt = field.options.find((o) => o.value === String(raw))
    if (opt) return opt.label
  }
  return String(raw)
}

export function ModuleMergeDialog({
  module,
  records,
  onClose,
  onMerged,
}: {
  module: ModuleDefinition
  records: MergeRecord[]
  onClose: () => void
  onMerged: () => void
}) {
  const fieldByKey = useMemo(() => new Map(module.fields.map((f) => [f.key, f])), [module])
  const [primaryId, setPrimaryId] = useState<number>(records[0]?.id ?? 0)
  // fieldKey -> source token ("primary" or a secondary id as string)
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [merging, setMerging] = useState(false)

  const secondaryIds = useMemo(
    () => records.map((r) => r.id).filter((id) => id !== primaryId),
    [records, primaryId],
  )
  const recordById = useMemo(() => new Map(records.map((r) => [r.id, r])), [records])

  const runPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/custom-modules/${module.slug}/records/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primaryId, secondaryIds, selections, dryRun: true }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.preview) {
        setPreview(body.preview as Preview)
      } else {
        setPreview(null)
        setError(body?.error ?? "Could not preview the merge.")
      }
    } finally {
      setLoading(false)
    }
  }, [module.slug, primaryId, secondaryIds, selections])

  useEffect(() => {
    if (primaryId > 0 && secondaryIds.length > 0) void runPreview()
  }, [primaryId, selections, runPreview, secondaryIds.length])

  function changePrimary(id: number) {
    setPrimaryId(id)
    setSelections({}) // sources are relative to the primary, so reset them
  }

  function sourceToken(recordId: number): string {
    return recordId === primaryId ? "primary" : String(recordId)
  }

  async function execute() {
    setMerging(true)
    setError(null)
    try {
      const res = await fetch(`/api/custom-modules/${module.slug}/records/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primaryId, secondaryIds, selections, dryRun: false }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        onMerged()
        return
      }
      setError(body?.error ?? "The merge could not be completed.")
    } finally {
      setMerging(false)
    }
  }

  const editableFields = module.fields.filter((f) => f.type !== "formula")

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            Merge {records.length} records
          </DialogTitle>
          <DialogDescription>
            Choose the record to keep, pick which value wins for each field, then merge. The other
            records are retired and can be restored from the merge history.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center gap-1.5">
              <Crown className="h-4 w-4" />
              Primary record (the survivor)
            </Label>
            <Select value={String(primaryId)} onValueChange={(v) => changePrimary(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {records.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    Record #{r.id}
                    {r.state ? ` · ${r.state}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Field values</Label>
            <div className="max-h-[40vh] overflow-auto rounded-md border">
              {editableFields.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">This module has no editable fields.</p>
              ) : (
                editableFields.map((field) => {
                  const token = selections[field.key] ?? "primary"
                  return (
                    <div
                      key={field.key}
                      className="flex flex-col gap-2 border-b p-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{field.label}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {formatValue(
                            field,
                            token === "primary"
                              ? recordById.get(primaryId)?.values[field.key]
                              : recordById.get(Number(token))?.values[field.key],
                          )}
                        </div>
                      </div>
                      <Select
                        value={token}
                        onValueChange={(v) => setSelections((prev) => ({ ...prev, [field.key]: v }))}
                      >
                        <SelectTrigger className="w-full sm:w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {records.map((r) => {
                            const t = sourceToken(r.id)
                            return (
                              <SelectItem key={r.id} value={t}>
                                {r.id === primaryId ? "Primary" : `Record #${r.id}`}:{" "}
                                {formatValue(field, r.values[field.key])}
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {preview && (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="gap-1">
                <Paperclip className="h-3.5 w-3.5" />
                {preview.attachmentCount} attachment{preview.attachmentCount === 1 ? "" : "s"} kept
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <Link2 className="h-3.5 w-3.5" />
                {preview.referenceChanges} reference{preview.referenceChanges === 1 ? "" : "s"} repointed
              </Badge>
              <Badge variant="outline">
                {preview.secondaryIds.length} record{preview.secondaryIds.length === 1 ? "" : "s"} retired
              </Badge>
            </div>
          )}

          {error && (
            <Card className="flex items-center gap-2 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={merging}>
            Cancel
          </Button>
          <Button onClick={execute} disabled={merging || loading || !preview}>
            <GitMerge className="mr-1.5 h-4 w-4" />
            {merging ? "Merging…" : "Merge records"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
