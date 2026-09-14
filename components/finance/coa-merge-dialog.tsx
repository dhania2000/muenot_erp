"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon, GitMerge, ArrowRight } from "lucide-react"

type Row = Record<string, any>
type Dependency = { table: string; label: string; count: number }
type Preview = {
  ok: boolean
  reason?: string
  dependencies?: Dependency[]
}

const MERGE_ENDPOINT = "/api/finance/chart-of-accounts/merge"

/**
 * Merge a duplicate/obsolete source account into a surviving target. Runs a live
 * dependency preview before the user confirms, then executes the merge which
 * repoints every live reference and archives the source as a tombstone. History
 * is preserved: posted vouchers keep their original snapshots.
 */
export function CoaMergeDialog({
  open,
  onOpenChange,
  accounts,
  presetSource,
  onMerged,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  accounts: Row[]
  presetSource: Row | null
  onMerged: () => void
}) {
  const [sourceId, setSourceId] = useState("")
  const [targetId, setTargetId] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed / reset when the dialog opens.
  useEffect(() => {
    if (!open) return
    setSourceId(presetSource ? String(presetSource.account_id) : "")
    setTargetId("")
    setPreview(null)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetSource?.account_id])

  const source = accounts.find((a) => String(a.account_id) === sourceId) ?? null

  // Merge is only valid within the same account group; a system account can
  // never be a source. The target list is filtered to matching, active, non-self.
  const sourceOptions = accounts
    .filter((a) => Number(a.is_system) !== 1 && !String(a.merged_into_account_id ?? ""))
    .sort((a, b) => String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")))
  const targetOptions = accounts
    .filter(
      (a) =>
        String(a.account_id) !== sourceId &&
        String(a.active_status ?? "Active") === "Active" &&
        (!source || a.account_group === source.account_group),
    )
    .sort((a, b) => String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")))

  // Fetch the dependency preview whenever both sides are chosen.
  useEffect(() => {
    if (!open || !sourceId || !targetId) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    setError(null)
    fetch(MERGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_account_id: sourceId, target_account_id: targetId, preview: true }),
    })
      .then(async (res) => ({ ok: res.ok, body: (await res.json().catch(() => ({}))) as Preview }))
      .then(({ body }) => {
        if (!cancelled) setPreview(body)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sourceId, targetId])

  const label = (a: Row | null) =>
    a ? `${a.account_code ? `${a.account_code} · ` : ""}${a.account_name}` : ""

  async function doMerge() {
    setMerging(true)
    setError(null)
    try {
      const res = await fetch(MERGE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_account_id: sourceId, target_account_id: targetId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "The merge could not be completed.")
        return
      }
      onMerged()
      onOpenChange(false)
    } finally {
      setMerging(false)
    }
  }

  const target = accounts.find((a) => String(a.account_id) === targetId) ?? null
  const canMerge = Boolean(sourceId && targetId && preview?.ok && !previewing && !merging)
  const totalRefs = (preview?.dependencies ?? []).reduce((s, d) => s + d.count, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5" />
            Merge accounts
          </DialogTitle>
          <DialogDescription>
            Move all activity from a duplicate account into a surviving one. History is preserved — posted vouchers keep
            their original details — and the source account is archived, not deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div>
            <p className="mb-1.5 text-sm font-medium">Source (merged away)</p>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the duplicate account" />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((a) => (
                  <SelectItem key={a.account_id} value={String(a.account_id)}>
                    {label(a)} <span className="text-muted-foreground">· {a.account_group}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-center text-muted-foreground">
            <ArrowRight className="size-4" />
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium">Target (survivor)</p>
            <Select value={targetId} onValueChange={setTargetId} disabled={!sourceId}>
              <SelectTrigger>
                <SelectValue placeholder={sourceId ? "Choose the account to keep" : "Select a source first"} />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((a) => (
                  <SelectItem key={a.account_id} value={String(a.account_id)}>
                    {label(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sourceId && targetOptions.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No other active accounts in the same type ({source?.account_group}) to merge into.
              </p>
            )}
          </div>

          {previewing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Checking dependencies…
            </div>
          )}

          {preview && !previewing && (
            <>
              {!preview.ok ? (
                <Alert variant="destructive">
                  <AlertDescription>{preview.reason}</AlertDescription>
                </Alert>
              ) : (
                <div className="rounded-md border bg-muted/40 p-3 text-sm">
                  <p className="mb-2 font-medium">
                    {totalRefs === 0
                      ? "No linked records — this account has no activity."
                      : `${totalRefs} linked record${totalRefs === 1 ? "" : "s"} will be repointed to ${label(target)}:`}
                  </p>
                  <ul className="space-y-1">
                    {(preview.dependencies ?? [])
                      .filter((d) => d.count > 0)
                      .map((d) => (
                        <li key={d.table} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{d.label}</span>
                          <Badge variant="secondary">{d.count}</Badge>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canMerge} onClick={doMerge}>
            {merging && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Merge accounts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
