"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  FileCheck2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Send,
  Rocket,
  Undo2,
  ShieldCheck,
  Loader2,
} from "lucide-react"
import { workflowLabel, type DocWorkflowType } from "@/lib/dms/model"
import type { DmsDocument } from "@/lib/dms/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

type ApprovalStep = {
  id: number
  levelNo: number
  levelName: string | null
  decision: "pending" | "approved" | "rejected" | null | string
  approverName: string | null
  actedAt: string | null
  comment: string | null
}

type ApprovalRequest = {
  id: number
  status: "pending" | "approved" | "rejected" | "cancelled"
  currentLevel: number | null
  requestedByName: string | null
  createdAt: string
} | null

type ConsoleItem = {
  document: DmsDocument
  request: ApprovalRequest
  steps: ApprovalStep[]
  canAct: boolean
  isRequester: boolean
}

type ConsoleResponse = {
  items: ConsoleItem[]
  currentUserId: number
  isAdmin: boolean
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type LifecycleKey = "submitted" | "review" | "approved" | "rejected" | "published" | "draft" | "archived"

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  review: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  published: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  archived: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
}

const FILTERS: { key: string; label: string; match: (d: DmsDocument) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "pending", label: "Awaiting", match: (d) => d.status === "submitted" || d.status === "review" },
  { key: "approved", label: "Approved", match: (d) => d.status === "approved" },
  { key: "published", label: "Published", match: (d) => d.status === "published" },
  { key: "rejected", label: "Rejected", match: (d) => d.status === "rejected" },
]

function formatDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function DocumentApprovalConsole() {
  const { data, isLoading, mutate } = useSWR<ConsoleResponse>("/api/dms/approvals", fetcher, {
    refreshInterval: 20000,
  })
  const [filter, setFilter] = useState("all")
  const [busyId, setBusyId] = useState<number | null>(null)
  const [rejectTarget, setRejectTarget] = useState<ConsoleItem | null>(null)
  const [rejectComment, setRejectComment] = useState("")

  const items = data?.items ?? []

  const stats = useMemo(() => {
    const s = { awaiting: 0, approved: 0, rejected: 0, published: 0 }
    for (const it of items) {
      const st = it.document.status
      if (st === "submitted" || st === "review") s.awaiting++
      else if (st === "approved") s.approved++
      else if (st === "rejected") s.rejected++
      else if (st === "published") s.published++
    }
    return s
  }, [items])

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]
    return items.filter((it) => f.match(it.document))
  }, [items, filter])

  async function act(item: ConsoleItem, action: string, comment?: string) {
    const reqId = item.request?.id
    setBusyId(item.document.id)
    try {
      let res: Response
      if (action === "approve" || action === "reject" || action === "withdraw") {
        // Route decisions through the shared approval engine.
        const engineAction = action === "withdraw" ? "cancel" : action
        res = await fetch(`/api/approvals/requests/${reqId}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: engineAction, comment: comment ?? null }),
        })
      } else {
        // Lifecycle transitions (publish / revert) act on the document itself.
        res = await fetch(`/api/dms/documents/${item.document.id}/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, comment: comment ?? null }),
        })
      }
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error ?? "Action failed. Please try again.")
        return
      }
      toast.success(`Document ${action}d.`)
      await mutate()
    } catch {
      toast.error("Action failed. Network error.")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileCheck2 className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Document Approval</h1>
            <p className="text-sm text-muted-foreground">
              Configurable approval workflows for SOPs, policies, contracts, invoice attachments and HR documents.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => mutate()} disabled={isLoading}>
          <RefreshCw className={cn("mr-2 size-4", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard icon={Clock} label="Awaiting approval" value={stats.awaiting} tone="text-amber-600" />
        <StatCard icon={CheckCircle2} label="Approved" value={stats.approved} tone="text-emerald-600" />
        <StatCard icon={Rocket} label="Published" value={stats.published} tone="text-green-600" />
        <StatCard icon={XCircle} label="Rejected" value={stats.rejected} tone="text-red-600" />
      </div>

      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.key} value={f.key}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" />
          Loading approvals…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-4">
          {filtered.map((item) => (
            <ApprovalCard
              key={item.document.id}
              item={item}
              busy={busyId === item.document.id}
              onApprove={() => act(item, "approve")}
              onReject={() => {
                setRejectTarget(item)
                setRejectComment("")
              }}
              onWithdraw={() => act(item, "withdraw")}
              onPublish={() => act(item, "publish")}
              onRevert={() => act(item, "revert")}
            />
          ))}
        </div>
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject document</DialogTitle>
            <DialogDescription>
              {rejectTarget ? `Reject "${rejectTarget.document.title}"? The requester will be notified.` : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection (optional)"
            value={rejectComment}
            onChange={(e) => setRejectComment(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = rejectTarget
                setRejectTarget(null)
                if (target) act(target, "reject", rejectComment.trim() || undefined)
              }}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Clock
  label: string
  value: number
  tone: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Icon className={cn("size-5 shrink-0", tone)} />
        <div className="min-w-0">
          <div className="text-2xl font-semibold leading-none">{value}</div>
          <div className="truncate text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function EmptyState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <FileCheck2 className="size-8 text-muted-foreground" />
        <p className="font-medium">No approvals here</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Documents submitted for approval appear here with their current workflow stage.
        </p>
      </CardContent>
    </Card>
  )
}

function ApprovalCard({
  item,
  busy,
  onApprove,
  onReject,
  onWithdraw,
  onPublish,
  onRevert,
}: {
  item: ConsoleItem
  busy: boolean
  onApprove: () => void
  onReject: () => void
  onWithdraw: () => void
  onPublish: () => void
  onRevert: () => void
}) {
  const { document: doc, request, steps, canAct, isRequester } = item
  const status = doc.status
  const isPending = status === "submitted" || status === "review"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CardTitle className="truncate text-base">{doc.title}</CardTitle>
              <Badge variant="outline" className="shrink-0 font-mono text-xs">
                {doc.docRef}
              </Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{workflowLabel(doc.workflowType as DocWorkflowType)}</Badge>
              <span>
                Requested by {request?.requestedByName ?? "—"} · {formatDate(request?.createdAt ?? doc.createdAt)}
              </span>
            </div>
          </div>
          <Badge className={cn("shrink-0 capitalize", STATUS_STYLES[status] ?? STATUS_STYLES.draft)}>{status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {steps.length > 0 && (
          <ol className="flex flex-col gap-2">
            {steps.map((s) => {
              const active = request?.status === "pending" && s.levelNo === request?.currentLevel && s.decision === "pending"
              return (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <StepIcon decision={s.decision} active={active} />
                  <span className="font-medium">
                    L{s.levelNo}
                    {s.levelName ? ` · ${s.levelName}` : ""}
                  </span>
                  <span className="text-muted-foreground">{s.approverName ?? "Unassigned"}</span>
                  {s.decision && s.decision !== "pending" && (
                    <span className="text-xs text-muted-foreground">
                      · {s.decision} {formatDate(s.actedAt)}
                    </span>
                  )}
                  {active && <span className="text-xs font-medium text-amber-600">· awaiting</span>}
                </li>
              )
            })}
          </ol>
        )}

        <div className="flex flex-wrap gap-2">
          {canAct && (
            <>
              <Button size="sm" onClick={onApprove} disabled={busy}>
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={onReject} disabled={busy}>
                <XCircle className="mr-2 size-4" />
                Reject
              </Button>
            </>
          )}
          {isRequester && isPending && (
            <Button size="sm" variant="ghost" onClick={onWithdraw} disabled={busy}>
              <Undo2 className="mr-2 size-4" />
              Withdraw
            </Button>
          )}
          {status === "approved" && (
            <Button size="sm" onClick={onPublish} disabled={busy}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Rocket className="mr-2 size-4" />}
              Publish
            </Button>
          )}
          {status === "rejected" && isRequester && (
            <Button size="sm" variant="outline" onClick={onRevert} disabled={busy}>
              <Send className="mr-2 size-4" />
              Return to draft
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function StepIcon({ decision, active }: { decision: ApprovalStep["decision"]; active: boolean }) {
  if (decision === "approved") return <CheckCircle2 className="size-4 text-emerald-600" />
  if (decision === "rejected") return <XCircle className="size-4 text-red-600" />
  if (active) return <Clock className="size-4 text-amber-600" />
  return <Clock className="size-4 text-muted-foreground" />
}
