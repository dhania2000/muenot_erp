"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Check, ClipboardList, History, ShieldCheck, UserCog, X } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import {
  GOV_ACTIONS,
  statusLabel,
  validateActionForStatus,
  type GovAction,
  type GovStatus,
} from "@/lib/master-data/governance-model"

const API = "/api/admin/governance/master-data"

// The four governed masters (SPEC 91 Phase 1), with friendly labels.
const KIND_LABELS: Record<string, string> = {
  currencies: "Currencies",
  payment_terms: "Payment terms",
  approval_levels: "Approval levels",
  cost_centers: "Cost centers",
}

const ACTION_LABELS: Record<GovAction, string> = {
  create: "Create",
  update: "Update",
  deactivate: "Deactivate",
  reactivate: "Reactivate",
  archive: "Archive",
}

const STATUS_TONE: Record<GovStatus, "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  pending_approval: "secondary",
  active: "secondary",
  inactive: "outline",
  archived: "destructive",
}

const LIFECYCLE: { status: GovStatus; description: string }[] = [
  { status: "draft", description: "Owner/authority set, not yet submitted." },
  { status: "pending_approval", description: "A change is awaiting a checker." },
  { status: "active", description: "Approved and effective. Selectable everywhere." },
  { status: "inactive", description: "Withdrawn from use, still resolvable for history." },
  { status: "archived", description: "Terminal. Can no longer change." },
]

type GovRecord = {
  id: number
  kind: string
  code: string
  status: GovStatus
  ownerId: number | null
  approvalAuthority: string | null
  effectiveDate: string | null
  version: number
  updatedAt: string
}

type ChangeRequest = {
  id: number
  kind: string
  code: string
  action: GovAction
  payload: Record<string, unknown> | null
  effectiveDate: string | null
  status: "pending" | "approved" | "rejected" | "cancelled"
  requestedBy: number | null
  requestComment: string | null
  reviewedBy: number | null
  reviewComment: string | null
  reviewedAt: string | null
  createdAt: string
}

type MasterRow = { code: string; name: string; active: boolean }

type ApiResponse = {
  governedKinds: string[]
  records: GovRecord[]
  requests: ChangeRequest[]
  values: MasterRow[] | null
}

type HistoryEntry = {
  id: number
  event: string
  fromStatus: GovStatus | null
  toStatus: GovStatus | null
  actorId: number | null
  detail: Record<string, unknown> | null
  createdAt: string
}

type UserRow = { id: number; name: string | null; email: string }

type MergedRow = {
  code: string
  name: string
  record: GovRecord | null
}

type ManageDraft = {
  code: string
  name: string
  record: GovRecord | null
  // Ownership fields.
  ownerId: string
  approvalAuthority: string
  // Change-request fields.
  action: GovAction | ""
  newName: string
  effectiveDate: string
  comment: string
}

function StatusBadge({ status }: { status: GovStatus }) {
  return (
    <Badge variant={STATUS_TONE[status]} className="text-[10px]">
      {statusLabel(status)}
    </Badge>
  )
}

export function MasterDataGovernance() {
  const [kind, setKind] = useState<string>("currencies")
  const key = `${API}?kind=${kind}`
  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(key, fetcher)
  const { data: usersData } = useSWR<{ users: UserRow[] }>("/api/admin/users", fetcher)

  const [managing, setManaging] = useState<ManageDraft | null>(null)
  const [historyFor, setHistoryFor] = useState<MergedRow | null>(null)
  const [busyRequestId, setBusyRequestId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const users = usersData?.users ?? []
  const userName = (id: number | null) => {
    if (id == null) return "—"
    const u = users.find((x) => x.id === id)
    return u ? (u.name || u.email) : `User #${id}`
  }

  const rows: MergedRow[] = useMemo(() => {
    const values = data?.values ?? []
    const records = data?.records ?? []
    const recByCode = new Map(records.map((r) => [r.code, r]))
    const byCode = new Map<string, MergedRow>()
    for (const v of values) byCode.set(v.code, { code: v.code, name: v.name, record: recByCode.get(v.code) ?? null })
    for (const r of records) {
      if (!byCode.has(r.code)) byCode.set(r.code, { code: r.code, name: r.code, record: r })
    }
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [data])

  const pendingRequests = (data?.requests ?? []).filter((r) => r.status === "pending")

  function openManage(row: MergedRow) {
    setManaging({
      code: row.code,
      name: row.name,
      record: row.record,
      ownerId: row.record?.ownerId != null ? String(row.record.ownerId) : "",
      approvalAuthority: row.record?.approvalAuthority ?? "",
      action: "",
      newName: row.name === row.code ? "" : row.name,
      effectiveDate: "",
      comment: "",
    })
  }

  async function saveOwnership() {
    if (!managing) return
    setSaving(true)
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          code: managing.code,
          ownerId: managing.ownerId === "" ? null : Number(managing.ownerId),
          approvalAuthority: managing.approvalAuthority.trim() || null,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save ownership")
      toast.success("Ownership updated.")
      await mutate()
      const updated = (await res.json()).record as GovRecord
      setManaging({ ...managing, record: updated })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function submitChange() {
    if (!managing || !managing.action) return
    const needsName = ["create", "update", "reactivate"].includes(managing.action)
    if (needsName && !managing.newName.trim()) {
      toast.error("A name is required for this change.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          code: managing.code,
          action: managing.action,
          payload: needsName ? { name: managing.newName.trim() } : undefined,
          effectiveDate: managing.effectiveDate || null,
          comment: managing.comment.trim() || null,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not submit change")
      toast.success("Change submitted for approval.")
      setManaging(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function decide(request: ChangeRequest, decision: "approved" | "rejected") {
    setBusyRequestId(request.id)
    try {
      const res = await fetch(`${API}/requests/${request.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not record decision")
      toast.success(decision === "approved" ? "Change approved and applied." : "Change rejected.")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyRequestId(null)
    }
  }

  // Actions legal from the current governance status (authoritative pure rule).
  const availableActions: GovAction[] = managing
    ? GOV_ACTIONS.filter((a) => validateActionForStatus(a, managing.record?.status ?? null).ok)
    : []

  return (
    <>
      {/* Lifecycle legend */}
      <div className="grid gap-3 sm:grid-cols-5">
        {LIFECYCLE.map((l) => (
          <Card key={l.status}>
            <CardContent className="flex flex-col gap-1.5 pt-4">
              <StatusBadge status={l.status} />
              <p className="text-xs text-muted-foreground">{l.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pending approvals */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="size-4 text-muted-foreground" />
            Pending approvals
          </CardTitle>
          <CardDescription>
            Maker/checker queue for {KIND_LABELS[kind] ?? kind}. A change is applied to the live master only once a
            different admin approves it (segregation of duties), and only when its effective date has arrived.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <Skeleton className="h-8 w-full" />
            </div>
          ) : pendingRequests.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No changes awaiting approval.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Value</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Comment</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingRequests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.code}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {ACTION_LABELS[r.action]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{userName(r.requestedBy)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.effectiveDate || "Immediate"}</TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                      {r.requestComment || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          disabled={busyRequestId === r.id}
                          onClick={() => decide(r, "approved")}
                        >
                          <Check className="size-3.5" />
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1 text-destructive"
                          disabled={busyRequestId === r.id}
                          onClick={() => decide(r, "rejected")}
                        >
                          <X className="size-3.5" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Governed values */}
      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-muted-foreground" />
              Governed values
            </CardTitle>
            <CardDescription>
              Assign an owner and approval authority, then propose lifecycle changes through the maker/checker workflow.
            </CardDescription>
          </div>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-full sm:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(data?.governedKinds ?? Object.keys(KIND_LABELS)).map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABELS[k] ?? k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <p className="p-6 text-sm text-destructive">{(error as Error).message}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Approval authority</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      No values for this master yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.code}>
                      <TableCell className="font-mono text-xs">{row.code}</TableCell>
                      <TableCell className="text-sm">{row.name}</TableCell>
                      <TableCell>
                        {row.record ? (
                          <StatusBadge status={row.record.status} />
                        ) : (
                          <span className="text-xs text-muted-foreground">Ungoverned</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{userName(row.record?.ownerId ?? null)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.record?.approvalAuthority || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.record?.effectiveDate || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Change history for ${row.code}`}
                            onClick={() => setHistoryFor(row)}
                          >
                            <History className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Manage ${row.code}`}
                            onClick={() => openManage(row)}
                          >
                            <UserCog className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Manage dialog: ownership + submit change */}
      <Dialog open={managing !== null} onOpenChange={(open) => !open && setManaging(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Govern {KIND_LABELS[kind] ?? kind} · <span className="font-mono">{managing?.code}</span>
            </DialogTitle>
            <DialogDescription>
              {managing?.record ? (
                <>
                  Current status: <span className="font-medium">{statusLabel(managing.record.status)}</span>
                </>
              ) : (
                "Not under governance yet — set ownership and/or submit a create request."
              )}
            </DialogDescription>
          </DialogHeader>

          {managing && (
            <div className="flex flex-col gap-5">
              {/* Ownership */}
              <div className="grid gap-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">Ownership &amp; authority</p>
                <div className="grid gap-2">
                  <Label htmlFor="md-owner">Owner</Label>
                  <Select
                    value={managing.ownerId || "none"}
                    onValueChange={(v) => setManaging({ ...managing, ownerId: v === "none" ? "" : v })}
                  >
                    <SelectTrigger id="md-owner">
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.name || u.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="md-authority">Approval authority</Label>
                  <Input
                    id="md-authority"
                    value={managing.approvalAuthority}
                    onChange={(e) => setManaging({ ...managing, approvalAuthority: e.target.value })}
                    placeholder="e.g. finance_controller (blank = any tenant admin)"
                  />
                </div>
                <Button variant="outline" size="sm" className="w-fit" disabled={saving} onClick={saveOwnership}>
                  Save ownership
                </Button>
              </div>

              {/* Submit change */}
              <div className="grid gap-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">Propose a change</p>
                {availableActions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No changes are possible from the current status.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-2">
                      <Label htmlFor="md-action">Action</Label>
                      <Select
                        value={managing.action || undefined}
                        onValueChange={(v) => setManaging({ ...managing, action: v as GovAction })}
                      >
                        <SelectTrigger id="md-action">
                          <SelectValue placeholder="Select an action" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableActions.map((a) => (
                            <SelectItem key={a} value={a}>
                              {ACTION_LABELS[a]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {managing.action && ["create", "update", "reactivate"].includes(managing.action) && (
                      <div className="grid gap-2">
                        <Label htmlFor="md-name">Name</Label>
                        <Input
                          id="md-name"
                          value={managing.newName}
                          onChange={(e) => setManaging({ ...managing, newName: e.target.value })}
                          placeholder="Value name"
                        />
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label htmlFor="md-effective">Effective date (optional)</Label>
                      <Input
                        id="md-effective"
                        type="date"
                        value={managing.effectiveDate}
                        onChange={(e) => setManaging({ ...managing, effectiveDate: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="md-comment">Comment (optional)</Label>
                      <Textarea
                        id="md-comment"
                        rows={2}
                        value={managing.comment}
                        onChange={(e) => setManaging({ ...managing, comment: e.target.value })}
                        placeholder="Why is this change needed?"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setManaging(null)} disabled={saving}>
              Close
            </Button>
            <Button onClick={submitChange} disabled={saving || !managing?.action}>
              Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History dialog */}
      <HistoryDialog kind={kind} row={historyFor} onClose={() => setHistoryFor(null)} userName={userName} />
    </>
  )
}

function HistoryDialog({
  kind,
  row,
  onClose,
  userName,
}: {
  kind: string
  row: MergedRow | null
  onClose: () => void
  userName: (id: number | null) => string
}) {
  const { data, isLoading } = useSWR<{ history: HistoryEntry[] }>(
    row ? `${API}/history?kind=${kind}&code=${encodeURIComponent(row.code)}` : null,
    fetcher,
  )
  const history = data?.history ?? []

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Change history · <span className="font-mono">{row?.code}</span>
          </DialogTitle>
          <DialogDescription>Append-only lifecycle trail for this governed value.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : history.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No history recorded yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {history.map((h) => (
              <li key={h.id} className="flex flex-col gap-1 border-l-2 border-muted pl-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {h.event}
                  </Badge>
                  {h.fromStatus && h.toStatus && (
                    <span className="text-xs text-muted-foreground">
                      {statusLabel(h.fromStatus)} → {statusLabel(h.toStatus)}
                    </span>
                  )}
                  {!h.fromStatus && h.toStatus && (
                    <span className="text-xs text-muted-foreground">{statusLabel(h.toStatus)}</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(h.createdAt).toLocaleString()} · {userName(h.actorId)}
                </span>
              </li>
            ))}
          </ol>
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
