"use client"

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Plus,
  Handshake,
  TrendingUp,
  Trophy,
  XCircle,
  MoreHorizontal,
  ShieldCheck,
  ShieldAlert,
  RotateCcw,
  Trash2,
  GripVertical,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

type Stage = {
  id: number
  pipeline_id: number
  name: string
  sort_order: number
  probability: number
  is_won: number
  is_lost: number
  requires_approval: number
}
type Pipeline = { id: number; name: string; description: string | null; is_default: number; stages: Stage[] }
type Deal = {
  id: number
  deal_code: string | null
  pipeline_id: number
  stage_id: number
  title: string
  company_name: string | null
  contact_person: string | null
  owner_id: number | null
  owner_name: string | null
  team_id: number | null
  expected_value: string
  currency: string
  probability: number | null
  expected_close_date: string | null
  status: "Open" | "Won" | "Lost"
  approval_status: "None" | "Pending" | "Approved" | "Rejected"
  lost_reason: string | null
  row_version: number
}
type Meta = { users: { id: number; name: string }[]; teams: { id: number; name: string }[] }

const LOST_REASONS = ["Budget", "Timing", "Competitor", "No decision", "No response", "Not a fit", "Lost to status quo", "Other"]

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function formatMoney(value: string | number, currency = "INR") {
  const n = Number(value) || 0
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toLocaleString()}`
  }
}

export function DealsClient({ canManage, canApprove }: { canManage: boolean; canApprove: boolean }) {
  const { data: config, mutate: mutateConfig } = useSWR<{ pipelines: Pipeline[] } & Meta>("/api/sales/pipelines", fetcher)
  const pipelines = config?.pipelines ?? []
  const meta: Meta = { users: config?.users ?? [], teams: config?.teams ?? [] }

  const [activePipelineId, setActivePipelineId] = useState<number | null>(null)
  const pipeline = useMemo(() => {
    if (pipelines.length === 0) return null
    return pipelines.find((p) => p.id === activePipelineId) ?? pipelines[0]
  }, [pipelines, activePipelineId])

  const { data: dealsData, mutate: mutateDeals, isLoading } = useSWR<{ deals: Deal[] }>(
    pipeline ? `/api/sales/deals?pipeline_id=${pipeline.id}` : null,
    fetcher,
  )
  const deals = dealsData?.deals ?? []

  const [dragId, setDragId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editDeal, setEditDeal] = useState<Deal | null>(null)
  const [loseTarget, setLoseTarget] = useState<Deal | null>(null)

  const refresh = useCallback(() => {
    mutateDeals()
    mutateConfig()
  }, [mutateDeals, mutateConfig])

  async function moveDeal(deal: Deal, stageId: number) {
    if (deal.stage_id === stageId) return
    // optimistic
    mutateDeals({ deals: deals.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId } : d)) }, false)
    const res = await fetch(`/api/sales/deals/${deal.id}/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage_id: stageId }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error || "Unable to move deal.")
    } else {
      const result = await res.json()
      if (result.status === "Won") toast.success(`${deal.title} marked Won`)
      else if (result.status === "Lost") toast.message(`${deal.title} moved to a lost stage`)
    }
    mutateDeals()
  }

  async function runAction(deal: Deal, action: string, extra: Record<string, unknown> = {}) {
    const res = await fetch(`/api/sales/deals/${deal.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error || "Action failed.")
      return false
    }
    toast.success("Done")
    refresh()
    return true
  }

  async function deleteDeal(deal: Deal) {
    const res = await fetch(`/api/sales/deals/${deal.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Unable to delete deal.")
      return
    }
    toast.success(`${deal.deal_code} deleted`)
    refresh()
  }

  // Forecast summary across open deals in this pipeline
  const summary = useMemo(() => {
    const open = deals.filter((d) => d.status === "Open")
    const won = deals.filter((d) => d.status === "Won")
    const pipelineValue = open.reduce((sum, d) => sum + Number(d.expected_value || 0), 0)
    const weighted = open.reduce((sum, d) => sum + (Number(d.expected_value || 0) * (d.probability ?? 0)) / 100, 0)
    const wonValue = won.reduce((sum, d) => sum + Number(d.expected_value || 0), 0)
    return { count: open.length, pipelineValue, weighted, wonValue, wonCount: won.length }
  }, [deals])

  const currency = deals[0]?.currency ?? "INR"

  if (!config) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading pipeline…</div>
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header + controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {pipelines.length > 1 && (
            <Select value={String(pipeline?.id)} onValueChange={(v) => setActivePipelineId(Number(v))}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Pipeline" />
              </SelectTrigger>
              <SelectContent>
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditDeal(null)
              setFormOpen(true)
            }}
          >
            <Plus className="size-4" />
            New Deal
          </Button>
        )}
      </div>

      {/* Forecast summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard icon={<Handshake className="size-4" />} label="Open Deals" value={String(summary.count)} />
        <SummaryCard icon={<TrendingUp className="size-4" />} label="Pipeline Value" value={formatMoney(summary.pipelineValue, currency)} />
        <SummaryCard icon={<TrendingUp className="size-4" />} label="Weighted Forecast" value={formatMoney(summary.weighted, currency)} />
        <SummaryCard icon={<Trophy className="size-4" />} label="Won" value={`${formatMoney(summary.wonValue, currency)} · ${summary.wonCount}`} />
      </div>

      {/* Kanban board */}
      <div className="flex gap-3 overflow-x-auto pb-3">
        {pipeline?.stages.map((stage) => {
          const stageDeals = deals.filter((d) => d.stage_id === stage.id)
          const stageValue = stageDeals.reduce((sum, d) => sum + Number(d.expected_value || 0), 0)
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                if (canManage) e.preventDefault()
              }}
              onDrop={() => {
                if (!canManage || dragId == null) return
                const d = deals.find((x) => x.id === dragId)
                if (d) moveDeal(d, stage.id)
                setDragId(null)
              }}
              className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{stage.name}</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                    {stageDeals.length}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {stage.requires_approval ? <ShieldAlert className="size-3.5 text-amber-500" /> : null}
                  <span>{stage.probability}%</span>
                </div>
              </div>
              <div className="px-3 py-1.5 text-xs text-muted-foreground">{formatMoney(stageValue, currency)}</div>
              <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                {stageDeals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    currency={currency}
                    canManage={canManage}
                    canApprove={canApprove}
                    draggable={canManage}
                    onDragStart={() => setDragId(deal.id)}
                    onEdit={() => {
                      setEditDeal(deal)
                      setFormOpen(true)
                    }}
                    onAction={runAction}
                    onLose={() => setLoseTarget(deal)}
                    onDelete={() => deleteDeal(deal)}
                  />
                ))}
                {stageDeals.length === 0 && (
                  <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                    {isLoading ? "…" : "No deals"}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {formOpen && pipeline && (
        <DealFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          pipeline={pipeline}
          meta={meta}
          deal={editDeal}
          onSaved={() => {
            setFormOpen(false)
            refresh()
          }}
        />
      )}

      {loseTarget && (
        <LoseDialog
          deal={loseTarget}
          onOpenChange={(o) => !o && setLoseTarget(null)}
          onConfirm={async (reason, note) => {
            const ok = await runAction(loseTarget, "lose", { reason, note })
            if (ok) setLoseTarget(null)
          }}
        />
      )}
    </div>
  )
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function DealCard({
  deal,
  currency,
  canManage,
  canApprove,
  draggable,
  onDragStart,
  onEdit,
  onAction,
  onLose,
  onDelete,
}: {
  deal: Deal
  currency: string
  canManage: boolean
  canApprove: boolean
  draggable: boolean
  onDragStart: () => void
  onEdit: () => void
  onAction: (deal: Deal, action: string, extra?: Record<string, unknown>) => void
  onLose: () => void
  onDelete: () => void
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn(
        "group rounded-md border border-border bg-card p-2.5 shadow-sm transition-colors",
        draggable && "cursor-grab active:cursor-grabbing hover:border-primary/40",
        deal.status === "Won" && "border-l-2 border-l-emerald-500",
        deal.status === "Lost" && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{deal.title}</div>
          <div className="truncate text-xs text-muted-foreground">{deal.company_name || "—"}</div>
        </div>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6 opacity-0 group-hover:opacity-100">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
              {deal.status === "Open" && (
                <>
                  <DropdownMenuItem onClick={() => onAction(deal, "win")}>
                    <Trophy className="size-4" />
                    Mark Won
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onLose}>
                    <XCircle className="size-4" />
                    Mark Lost
                  </DropdownMenuItem>
                  {deal.approval_status === "None" || deal.approval_status === "Rejected" ? (
                    <DropdownMenuItem onClick={() => onAction(deal, "request_approval")}>
                      <ShieldCheck className="size-4" />
                      Request Approval
                    </DropdownMenuItem>
                  ) : null}
                </>
              )}
              {deal.status !== "Open" && (
                <DropdownMenuItem onClick={() => onAction(deal, "reopen")}>
                  <RotateCcw className="size-4" />
                  Reopen
                </DropdownMenuItem>
              )}
              {canApprove && deal.approval_status === "Pending" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onAction(deal, "approve")}>
                    <ShieldCheck className="size-4 text-emerald-500" />
                    Approve
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAction(deal, "reject")}>
                    <ShieldAlert className="size-4 text-red-500" />
                    Reject
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">{formatMoney(deal.expected_value, currency)}</span>
        <span className="text-xs text-muted-foreground">{deal.probability ?? 0}%</span>
      </div>
      <Progress value={deal.probability ?? 0} className="mt-1 h-1" />

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {deal.deal_code && (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
            {deal.deal_code}
          </Badge>
        )}
        {deal.owner_name && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
            {deal.owner_name}
          </Badge>
        )}
        {deal.status === "Won" && <Badge className="h-5 bg-emerald-500 px-1.5 text-[10px]">Won</Badge>}
        {deal.status === "Lost" && (
          <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
            Lost{deal.lost_reason ? ` · ${deal.lost_reason}` : ""}
          </Badge>
        )}
        {deal.approval_status === "Pending" && (
          <Badge className="h-5 bg-amber-500 px-1.5 text-[10px]">Approval pending</Badge>
        )}
        {deal.approval_status === "Approved" && (
          <Badge variant="outline" className="h-5 border-emerald-500 px-1.5 text-[10px] text-emerald-600">
            Approved
          </Badge>
        )}
        {deal.approval_status === "Rejected" && (
          <Badge variant="outline" className="h-5 border-red-500 px-1.5 text-[10px] text-red-600">
            Rejected
          </Badge>
        )}
      </div>
    </div>
  )
}

function DealFormDialog({
  open,
  onOpenChange,
  pipeline,
  meta,
  deal,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  pipeline: Pipeline
  meta: Meta
  deal: Deal | null
  onSaved: () => void
}) {
  const isEdit = !!deal
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    title: deal?.title ?? "",
    company_name: deal?.company_name ?? "",
    contact_person: deal?.contact_person ?? "",
    stage_id: String(deal?.stage_id ?? pipeline.stages[0]?.id ?? ""),
    owner_id: deal?.owner_id ? String(deal.owner_id) : "",
    team_id: deal?.team_id ? String(deal.team_id) : "",
    expected_value: deal ? String(deal.expected_value) : "",
    probability: deal?.probability != null ? String(deal.probability) : "",
    expected_close_date: deal?.expected_close_date ?? "",
    currency: deal?.currency ?? "INR",
  })

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.title.trim()) {
      toast.error("Deal title is required")
      return
    }
    setSaving(true)
    const payload: Record<string, unknown> = {
      title: form.title,
      company_name: form.company_name || null,
      contact_person: form.contact_person || null,
      owner_id: form.owner_id || null,
      team_id: form.team_id || null,
      expected_value: form.expected_value || 0,
      probability: form.probability === "" ? null : form.probability,
      expected_close_date: form.expected_close_date || null,
      currency: form.currency,
    }
    let res: Response
    if (isEdit) {
      res = await fetch(`/api/sales/deals/${deal!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, row_version: deal!.row_version }),
      })
    } else {
      res = await fetch("/api/sales/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, pipeline_id: pipeline.id, stage_id: form.stage_id }),
      })
    }
    setSaving(false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error || "Unable to save deal.")
      return
    }
    toast.success(isEdit ? "Deal updated" : "Deal created")
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Deal" : "New Deal"}</DialogTitle>
          <DialogDescription>{pipeline.name}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="deal-title">Title</Label>
            <Input id="deal-title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Enterprise licence renewal" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="deal-company">Company</Label>
              <Input id="deal-company" value={form.company_name} onChange={(e) => set("company_name", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="deal-contact">Contact</Label>
              <Input id="deal-contact" value={form.contact_person} onChange={(e) => set("contact_person", e.target.value)} />
            </div>
          </div>
          {!isEdit && (
            <div className="grid gap-1.5">
              <Label>Stage</Label>
              <Select value={form.stage_id} onValueChange={(v) => set("stage_id", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pipeline.stages
                    .filter((s) => !s.is_won && !s.is_lost)
                    .map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name} ({s.probability}%)
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="deal-value">Expected Value</Label>
              <Input id="deal-value" type="number" min="0" value={form.expected_value} onChange={(e) => set("expected_value", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="deal-prob">Probability %</Label>
              <Input id="deal-prob" type="number" min="0" max="100" value={form.probability} onChange={(e) => set("probability", e.target.value)} placeholder="Stage default" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Owner</Label>
              <Select value={form.owner_id || "none"} onValueChange={(v) => set("owner_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {meta.users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="deal-close">Expected Close</Label>
              <Input id="deal-close" type="date" value={form.expected_close_date ?? ""} onChange={(e) => set("expected_close_date", e.target.value)} />
            </div>
          </div>
          {meta.teams.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Team</Label>
              <Select value={form.team_id || "none"} onValueChange={(v) => set("team_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="No team" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No team</SelectItem>
                  {meta.teams.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LoseDialog({
  deal,
  onOpenChange,
  onConfirm,
}: {
  deal: Deal
  onOpenChange: (o: boolean) => void
  onConfirm: (reason: string, note: string) => void
}) {
  const [reason, setReason] = useState(deal.lost_reason || LOST_REASONS[0])
  const [note, setNote] = useState("")
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark deal as Lost</DialogTitle>
          <DialogDescription>{deal.title}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOST_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lose-note">Notes (optional)</Label>
            <Textarea id="lose-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(reason, note)}>
            Mark Lost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
