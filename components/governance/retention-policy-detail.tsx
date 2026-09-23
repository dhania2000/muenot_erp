"use client"

import { useState } from "react"
import useSWR from "swr"
import { Gavel, Play, Plus, ShieldAlert, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import type { RetentionPolicy, RetentionException, RetentionRun, RetentionExceptionType } from "./retention-types"

const API = "/api/admin/governance/retention"

type DetailResponse = {
  policy: RetentionPolicy
  exceptions: RetentionException[]
  runs: RetentionRun[]
}

const runStateTone: Record<RetentionPolicy["runState"], "secondary" | "outline" | "destructive"> = {
  active: "secondary",
  paused: "outline",
  held: "destructive",
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}

export function RetentionPolicyDetail({
  policyId,
  open,
  onOpenChange,
  onChanged,
}: {
  policyId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const key = policyId != null && open ? `${API}/${policyId}` : null
  const { data, isLoading, mutate } = useSWR<DetailResponse>(key, fetcher)
  const policy = data?.policy ?? null

  const [holdReason, setHoldReason] = useState("")
  const [busy, setBusy] = useState(false)

  // Exception draft
  const [excType, setExcType] = useState<RetentionExceptionType>("record")
  const [recordRef, setRecordRef] = useState("")
  const [matchField, setMatchField] = useState("")
  const [matchValue, setMatchValue] = useState("")
  const [excReason, setExcReason] = useState("")

  function refreshAll() {
    mutate()
    onChanged()
  }

  async function patchPolicy(patch: Record<string, unknown>, successMsg: string) {
    if (!policy) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/${policy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not update policy")
      }
      toast.success(successMsg)
      refreshAll()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleLegalHold(next: boolean) {
    await patchPolicy(
      { legalHold: next, legalHoldReason: next ? holdReason.trim() || null : null },
      next ? "Legal hold placed. Automated action is now blocked." : "Legal hold released.",
    )
    if (!next) setHoldReason("")
  }

  async function togglePause() {
    if (!policy) return
    await patchPolicy(
      { status: policy.status === "paused" ? "active" : "paused" },
      policy.status === "paused" ? "Policy resumed." : "Policy paused.",
    )
  }

  async function run(dryRun: boolean) {
    if (!policy) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/${policy.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Run failed")
      const o = body.outcome as RetentionRun
      if (dryRun) {
        toast.success(`Dry run: ${o.evaluated} record(s) currently eligible.`)
      } else if (o.status === "skipped") {
        toast.message("Policy skipped", { description: o.reason ?? undefined })
      } else if (o.status === "failed") {
        toast.error(o.reason || "Run failed")
      } else {
        toast.success(`Run complete — archived ${o.archived}, deleted ${o.deleted}.`)
      }
      refreshAll()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function addException() {
    if (!policy) return
    const payload =
      excType === "record"
        ? { type: "record", recordRef: recordRef.trim(), reason: excReason.trim() }
        : { type: "criteria", matchField: matchField.trim(), matchValue: matchValue.trim(), reason: excReason.trim() }
    setBusy(true)
    try {
      const res = await fetch(`${API}/${policy.id}/exceptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not add exception")
      }
      toast.success("Exception added.")
      setRecordRef("")
      setMatchField("")
      setMatchValue("")
      setExcReason("")
      refreshAll()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeException(exceptionId: number) {
    if (!policy) return
    try {
      const res = await fetch(`${API}/${policy.id}/exceptions/${exceptionId}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not remove exception")
      }
      toast.success("Exception removed.")
      refreshAll()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2">
            {policy ? `${policy.module} / ${policy.recordType}` : "Retention policy"}
          </SheetTitle>
          <SheetDescription>
            {policy
              ? `Keep for ${policy.retentionLabel}, then ${policy.action}${
                  policy.action === "archive" && policy.purgeAfterArchive ? " and purge from the live table" : ""
                }.`
              : "Manage legal hold, exceptions and lifecycle runs."}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !policy ? (
          <div className="space-y-3 p-1 pt-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-6 py-4">
            {/* Status + quick actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={runStateTone[policy.runState]} className="capitalize">
                {policy.runState}
              </Badge>
              <Badge variant="outline" className="capitalize">
                {policy.action}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Last run {formatDateTime(policy.lastRunAt)} · {policy.lastRunAffected} affected
              </span>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" onClick={() => run(true)} disabled={busy}>
                  Dry run
                </Button>
                <Button size="sm" onClick={() => run(false)} disabled={busy || policy.runState !== "active"} className="gap-1.5">
                  <Play className="size-3.5" />
                  Run now
                </Button>
              </div>
            </div>

            {policy.runState === "active" ? (
              <Button size="sm" variant="ghost" className="w-fit" onClick={togglePause} disabled={busy}>
                Pause this policy
              </Button>
            ) : policy.runState === "paused" ? (
              <Button size="sm" variant="ghost" className="w-fit" onClick={togglePause} disabled={busy}>
                Resume this policy
              </Button>
            ) : null}

            <Separator />

            {/* Legal hold */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Gavel className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Legal hold</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                A legal hold overrides everything: while active, neither the scheduler nor a manual run will archive or
                delete any records under this policy — even if the policy is otherwise active.
              </p>
              {policy.legalHold ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <ShieldAlert className="size-4" />
                    Hold active
                  </div>
                  {policy.legalHoldReason && (
                    <p className="mt-1 text-xs text-muted-foreground">{policy.legalHoldReason}</p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => toggleLegalHold(false)}
                    disabled={busy}
                  >
                    Release hold
                  </Button>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="hold-reason" className="text-xs font-normal">
                    Reason (optional)
                  </Label>
                  <Textarea
                    id="hold-reason"
                    value={holdReason}
                    onChange={(e) => setHoldReason(e.target.value)}
                    placeholder="e.g. Litigation — vendor dispute #2291"
                    rows={2}
                  />
                  <Button size="sm" variant="outline" className="w-fit gap-1.5" onClick={() => toggleLegalHold(true)} disabled={busy}>
                    <Gavel className="size-3.5" />
                    Place legal hold
                  </Button>
                </div>
              )}
            </section>

            <Separator />

            {/* Exceptions */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Exceptions ({data?.exceptions.length ?? 0})</h3>
              <p className="text-xs text-muted-foreground">
                Carve specific records or a field/value match out of this policy so the lifecycle never touches them.
              </p>

              {(data?.exceptions.length ?? 0) > 0 && (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Match</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data!.exceptions.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] capitalize">
                              {e.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {e.type === "record" ? `#${e.recordRef}` : `${e.matchField} = ${e.matchValue}`}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{e.reason || "—"}</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label="Remove exception"
                              onClick={() => removeException(e.id)}
                            >
                              <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div className="grid gap-3 rounded-md border p-3">
                <div className="grid gap-2">
                  <Label className="text-xs font-normal">Exception type</Label>
                  <Select value={excType} onValueChange={(v) => setExcType(v as RetentionExceptionType)}>
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="record">Specific record</SelectItem>
                      <SelectItem value="criteria">Field / value match</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {excType === "record" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="exc-ref" className="text-xs font-normal">
                      Record ID
                    </Label>
                    <Input
                      id="exc-ref"
                      value={recordRef}
                      onChange={(e) => setRecordRef(e.target.value)}
                      placeholder="e.g. 4821"
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-2">
                      <Label htmlFor="exc-field" className="text-xs font-normal">
                        Field
                      </Label>
                      <Input
                        id="exc-field"
                        value={matchField}
                        onChange={(e) => setMatchField(e.target.value)}
                        placeholder="e.g. region"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="exc-value" className="text-xs font-normal">
                        Equals
                      </Label>
                      <Input
                        id="exc-value"
                        value={matchValue}
                        onChange={(e) => setMatchValue(e.target.value)}
                        placeholder="e.g. EU"
                      />
                    </div>
                  </div>
                )}
                <div className="grid gap-2">
                  <Label htmlFor="exc-reason" className="text-xs font-normal">
                    Reason (optional)
                  </Label>
                  <Input
                    id="exc-reason"
                    value={excReason}
                    onChange={(e) => setExcReason(e.target.value)}
                    placeholder="Why is this exempt?"
                  />
                </div>
                <Button size="sm" variant="outline" className="w-fit gap-1.5" onClick={addException} disabled={busy}>
                  <Plus className="size-3.5" />
                  Add exception
                </Button>
              </div>
            </section>

            <Separator />

            {/* Run history */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Run history</h3>
              {(data?.runs.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">No runs recorded yet.</p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Trigger</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data!.runs.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs">{formatDateTime(r.startedAt)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] capitalize">
                              {r.triggerSource}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                r.status === "failed" ? "destructive" : r.status === "skipped" ? "outline" : "secondary"
                              }
                              className="text-[10px] capitalize"
                            >
                              {r.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {r.status === "success"
                              ? `${r.archived} archived · ${r.deleted} deleted`
                              : (r.reason ?? "—")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
