"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import Link from "next/link"
import {
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  Pencil,
  Repeat,
  ScrollText,
  StopCircle,
  Undo2,
} from "lucide-react"
import { shiftTimeLabel } from "./shift-change-status"

export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual HR",
  SHIFT_CHANGE_REQUEST: "Shift Change Request",
  ROTATION: "Rotation",
  IMPORT: "Import",
  SYSTEM: "System",
}

export function derivedStateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "Active Now":
      return "default"
    case "Upcoming":
      return "secondary"
    case "Historical":
      return "outline"
    default:
      return "outline"
  }
}

const EVENT_ICONS: Record<string, any> = {
  created: Clock,
  updated: Pencil,
  ended: StopCircle,
  activated: CheckCircle2,
  deactivated: Ban,
}

function fmtDateTime(value: unknown) {
  if (!value) return "—"
  return String(value).slice(0, 16).replace("T", " ")
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm">{value ?? "—"}</p>
    </div>
  )
}

export function ShiftAssignmentDetailDialog({
  assignmentId,
  onClose,
  onChanged,
}: {
  assignmentId: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, mutate, isLoading } = useSWR<any>(
    assignmentId ? `/api/hr/shift-assignments/${assignmentId}` : null,
    fetcher,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<"view" | "edit" | "end">("view")
  const [reason, setReason] = useState("")
  const [endDate, setEndDate] = useState("")
  const [editFrom, setEditFrom] = useState("")
  const [editTo, setEditTo] = useState("")
  const [editType, setEditType] = useState<"Permanent" | "Temporary">("Permanent")
  const [editNotes, setEditNotes] = useState("")

  const a = data?.assignment
  const events: any[] = data?.events || []
  const canManage = data?.canManage
  const derived = a?.derived_state as string | undefined
  const source = a?.source_type || "MANUAL"
  const sourceRef = a?.source_id || a?.source_request_id || null

  function close() {
    setMode("view")
    setReason("")
    onClose()
  }

  function startEdit() {
    setEditFrom(String(a.effective_from).slice(0, 10))
    setEditTo(a.effective_to ? String(a.effective_to).slice(0, 10) : "")
    setEditType((a.change_type as "Permanent" | "Temporary") || "Permanent")
    setEditNotes(a.notes || "")
    setMode("edit")
  }

  function startEnd() {
    setEndDate(a.effective_to ? String(a.effective_to).slice(0, 10) : new Date().toISOString().slice(0, 10))
    setMode("end")
  }

  async function patch(body: any, successMsg: string) {
    if (!assignmentId) return
    setBusy(body.action)
    try {
      const res = await fetch(`/api/hr/shift-assignments/${assignmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Action failed.")
        return
      }
      toast.success(successMsg)
      setMode("view")
      setReason("")
      mutate()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={Boolean(assignmentId)} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-base">{a?.assignment_id || "Assignment"}</span>
            {derived && <Badge variant={derivedStateVariant(derived)}>{derived}</Badge>}
            {a?.change_type && <Badge variant="outline">{a.change_type}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {a ? `${a.employee_name || "Employee"}${a.department ? ` · ${a.department}` : ""}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !a ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            {/* Employee + shift facts (all read from masters) */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Employee</p>
                <p className="mt-1 font-medium">{a.employee_name}</p>
                <p className="text-xs text-muted-foreground">
                  {a.employee_code}
                  {a.designation ? ` · ${a.designation}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">Mgr: {a.reporting_manager || "—"}</p>
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Shift</p>
                <p className="mt-1 font-medium">{a.shift_name || "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {shiftTimeLabel(a.start_time, a.end_time, Boolean(Number(a.is_overnight)))}
                  {a.shift_code ? ` · ${a.shift_code}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {a.working_hours ? `${a.working_hours}h` : "—"}
                  {a.break_minutes ? ` · ${a.break_minutes}m break` : ""}
                  {Number(a.overtime_enabled) ? " · OT" : ""}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Detail label="Type" value={a.change_type} />
              <Detail label="Effective from" value={String(a.effective_from).slice(0, 10)} />
              <Detail
                label="Effective to"
                value={a.effective_to ? String(a.effective_to).slice(0, 10) : "Onward"}
              />
              <Detail label="Status" value={a.status} />
              <Detail label="Source" value={SOURCE_LABELS[source] || source} />
              <Detail label="Source ref" value={sourceRef || "—"} />
              <Detail label="Assigned by" value={a.assigned_by_name || "—"} />
              <Detail label="Assigned at" value={a.created_at ? String(a.created_at).slice(0, 10) : "—"} />
              <Detail label="Shift status" value={a.shift_status || "—"} />
            </div>

            {a.notes ? (
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">Notes</p>
                <p className="mt-1 text-sm">{a.notes}</p>
              </div>
            ) : null}

            {/* Source cross-links */}
            {source === "SHIFT_CHANGE_REQUEST" && sourceRef ? (
              <Link
                href="/modules/hr/shift-change-requests"
                className="inline-flex items-center gap-1.5 text-sm text-primary underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View source shift change request {sourceRef}
              </Link>
            ) : null}
            {source === "ROTATION" ? (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Repeat className="h-3.5 w-3.5" /> Derived from a shift rotation.
              </p>
            ) : null}

            <div>
              <Link
                href={`/modules/hr/employees/${a.employee_id}?tab=shift`}
                className="inline-flex items-center gap-1.5 text-sm text-primary underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open employee profile
              </Link>
            </div>

            {/* Management actions */}
            {canManage && mode === "view" && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={startEdit}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                </Button>
                {a.status === "Active" && (
                  <Button size="sm" variant="outline" onClick={startEnd}>
                    <StopCircle className="mr-1.5 h-3.5 w-3.5" /> End assignment
                  </Button>
                )}
                {a.status === "Active" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={Boolean(busy)}
                    onClick={() => patch({ action: "deactivate", reason: reason || null }, "Assignment deactivated.")}
                  >
                    <Ban className="mr-1.5 h-3.5 w-3.5" /> Deactivate
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => patch({ action: "reactivate", reason: reason || null }, "Assignment reactivated.")}
                  >
                    <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Reactivate
                  </Button>
                )}
              </div>
            )}

            {canManage && mode === "edit" && (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">Edit assignment</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="sae-type">Type</Label>
                    <Select value={editType} onValueChange={(v) => setEditType((v as "Permanent" | "Temporary") ?? "Permanent")}>
                      <SelectTrigger id="sae-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Permanent">Permanent</SelectItem>
                        <SelectItem value="Temporary">Temporary</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="sae-from">Effective from</Label>
                    <Input id="sae-from" type="date" value={editFrom} onChange={(e) => setEditFrom(e.target.value)} />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sae-to">Effective to</Label>
                  <Input
                    id="sae-to"
                    type="date"
                    value={editTo}
                    min={editFrom}
                    onChange={(e) => setEditTo(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sae-notes">Notes</Label>
                  <Textarea id="sae-notes" rows={2} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      patch(
                        {
                          action: "edit",
                          effective_from: editFrom,
                          effective_to: editType === "Temporary" ? editTo : editTo || null,
                          change_type: editType,
                          notes: editNotes || null,
                          is_override: true,
                        },
                        "Assignment updated.",
                      )
                    }
                  >
                    Save changes
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode("view")}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {canManage && mode === "end" && (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">End assignment</p>
                <p className="text-xs text-muted-foreground">
                  Sets the effective-to date; history is preserved and never deleted.
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="sae-end">Effective to</Label>
                  <Input id="sae-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sae-end-reason">Reason</Label>
                  <Textarea id="sae-end-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={Boolean(busy) || !endDate}
                    onClick={() => patch({ action: "end", effective_to: endDate, reason: reason || null }, "Assignment ended.")}
                  >
                    End assignment
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode("view")}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <Separator />

            {/* Audit history */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <ScrollText className="h-3.5 w-3.5" /> Audit history
              </p>
              <ol className="space-y-3">
                {events.map((e) => {
                  const Icon = EVENT_ICONS[e.event_type] || History
                  const changes = Array.isArray(e.changes) ? e.changes : e.changes ? JSON.parse(e.changes) : []
                  return (
                    <li key={e.id} className="flex gap-3">
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="text-sm">
                        <p>{e.summary}</p>
                        {changes.length > 0 && (
                          <ul className="mt-0.5 list-inside list-disc text-xs text-muted-foreground">
                            {changes.map((c: any, i: number) => (
                              <li key={i}>
                                {(c.label || c.field)}: {c.from === null || c.from === "" ? "—" : String(c.from)} →{" "}
                                {c.to === null || c.to === "" ? "—" : String(c.to)}
                              </li>
                            ))}
                          </ul>
                        )}
                        {e.reason ? <p className="text-xs text-muted-foreground">Reason: {e.reason}</p> : null}
                        <p className="text-xs text-muted-foreground">
                          {e.actor_name ? `${e.actor_name} · ` : ""}
                          {fmtDateTime(e.created_at)}
                        </p>
                      </div>
                    </li>
                  )
                })}
                {events.length === 0 && <li className="text-sm text-muted-foreground">No events yet.</li>}
              </ol>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
