"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Workflow,
  Plus,
  UserPlus,
  CheckCircle2,
  Search,
  MoreHorizontal,
  Play,
  Pause,
  Copy,
  Archive,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import {
  STEP_META,
  TRIGGER_META,
  TRIGGER_ORDER,
  JOURNEY_STATUS_VARIANT,
  type Lookups,
  type StepType,
} from "@/components/marketing/journeys-constants"
import { JourneyBuilder } from "@/components/marketing/marketing-journey-builder"
import { JourneyDetail } from "@/components/marketing/marketing-journey-detail"

const PAGE_SIZE = 20

export function MarketingJourneysClient({ canManage = false }: { canManage?: boolean }) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [trigger, setTrigger] = useState("all")
  const [sort, setSort] = useState("recent")
  const [page, setPage] = useState(1)

  const [builderOpen, setBuilderOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)

  const params = new URLSearchParams()
  if (search) params.set("search", search)
  if (status !== "all") params.set("status", status)
  if (trigger !== "all") params.set("trigger", trigger)
  params.set("sort", sort)
  params.set("page", String(page))
  params.set("pageSize", String(PAGE_SIZE))

  const listKey = `/api/marketing/journeys?${params.toString()}`
  const { data, isLoading, mutate } = useSWR(listKey, fetcher)
  const { data: lookups } = useSWR<Lookups>("/api/marketing/journeys/lookups", fetcher)

  const journeys: any[] = data?.items || []
  const total: number = data?.total || 0
  const summary = data?.summary || {}
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function refresh() {
    mutate()
  }

  function openNew() {
    setEditingId(null)
    setBuilderOpen(true)
  }

  function openEdit(id: number) {
    setEditingId(id)
    setBuilderOpen(true)
  }

  async function setStatusAction(id: number, next: string) {
    const res = await fetch(`/api/marketing/journeys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", status: next }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Could not update status")
      return
    }
    toast.success(`Journey ${next === "Active" ? "activated" : next.toLowerCase()}`)
    refresh()
  }

  async function duplicate(id: number) {
    const res = await fetch(`/api/marketing/journeys/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "duplicate" }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Could not duplicate")
      return
    }
    toast.success("Journey duplicated")
    refresh()
    openEdit(body.id)
  }

  async function archive(id: number) {
    const res = await fetch(`/api/marketing/journeys/${id}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Could not archive journey")
      return
    }
    toast.success("Journey archived")
    refresh()
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Journeys"
        description="Automated, multi-step customer journeys that trigger on behaviour and guide contacts toward a goal."
        action={
          canManage ? (
            <Button onClick={openNew}>
              <Plus className="size-4" />
              New Journey
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Active Journeys"
          value={(summary.activeJourneys ?? 0).toLocaleString()}
          hint={`${(summary.totalJourneys ?? 0).toLocaleString()} total`}
          icon={Workflow}
        />
        <StatCard
          label="Contacts Enrolled"
          value={(summary.contactsEnrolled ?? 0).toLocaleString()}
          hint={`${(summary.activeEnrollments ?? 0).toLocaleString()} currently active`}
          icon={UserPlus}
        />
        <StatCard
          label="Avg. Completion"
          value={summary.avgCompletionRate != null ? `${summary.avgCompletionRate}%` : "—"}
          hint={`${(summary.completedEnrollments ?? 0).toLocaleString()} completed`}
          icon={CheckCircle2}
        />
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search journeys…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                className="pl-8"
              />
            </div>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Draft">Draft</SelectItem>
                <SelectItem value="Paused">Paused</SelectItem>
                <SelectItem value="Completed">Completed</SelectItem>
                <SelectItem value="Archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={trigger}
              onValueChange={(v) => {
                setTrigger(v)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Trigger" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All triggers</SelectItem>
                {TRIGGER_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Recently updated</SelectItem>
                <SelectItem value="created">Newest</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="enrolled">Most enrolled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-4">
            {isLoading && (
              <div className="py-16 text-center text-sm text-muted-foreground">Loading journeys…</div>
            )}

            {!isLoading && journeys.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <Workflow className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No journeys found.{" "}
                  {canManage ? "Create your first automated journey to get started." : ""}
                </p>
                {canManage && (
                  <Button onClick={openNew} variant="outline">
                    <Plus className="size-4" />
                    New Journey
                  </Button>
                )}
              </div>
            )}

            {journeys.map((j) => {
              const trig = TRIGGER_META[j.trigger_type as keyof typeof TRIGGER_META]
              const completion = j.total_enrolled
                ? `${Math.round((j.completed_enrolled / j.total_enrolled) * 100)}%`
                : "—"
              return (
                <Card key={j.id} className="transition-colors hover:border-primary/40">
                  <CardContent className="flex flex-col gap-4 pt-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setDetailId(j.id)}
                        className="flex flex-col items-start gap-1 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{j.name}</span>
                          <Badge variant={JOURNEY_STATUS_VARIANT[j.status] || "outline"}>{j.status}</Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {j.journey_code}
                          {j.description ? ` · ${j.description}` : ""}
                        </span>
                      </button>
                      <div className="flex items-center gap-2">
                        {trig && (
                          <Badge variant="outline" className="gap-1 font-normal">
                            <trig.icon className="size-3" />
                            {trig.label}
                          </Badge>
                        )}
                        {canManage && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-8">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>{j.journey_code}</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => setDetailId(j.id)}>View details</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openEdit(j.id)}>Edit</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {j.status === "Active" ? (
                                <DropdownMenuItem onClick={() => setStatusAction(j.id, "Paused")}>
                                  <Pause className="size-4" />
                                  Pause
                                </DropdownMenuItem>
                              ) : j.status === "Draft" || j.status === "Paused" ? (
                                <DropdownMenuItem onClick={() => setStatusAction(j.id, "Active")}>
                                  <Play className="size-4" />
                                  Activate
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem onClick={() => duplicate(j.id)}>
                                <Copy className="size-4" />
                                Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <a href={`/api/marketing/journeys/${j.id}/export`}>
                                  <Download className="size-4" />
                                  Export enrollments
                                </a>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={() => archive(j.id)}>
                                <Archive className="size-4" />
                                Archive
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>

                    <StepChips stepCount={j.step_count} journeyId={j.id} />

                    <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
                      <span>
                        <span className="font-medium text-foreground tabular-nums">
                          {Number(j.total_enrolled).toLocaleString()}
                        </span>{" "}
                        enrolled
                      </span>
                      <span>
                        <span className="font-medium text-foreground tabular-nums">
                          {Number(j.active_enrolled).toLocaleString()}
                        </span>{" "}
                        active
                      </span>
                      <span>
                        <span className="font-medium text-foreground">{completion}</span> completion
                      </span>
                      <span>
                        <span className="font-medium text-foreground tabular-nums">{j.step_count}</span> steps
                      </span>
                      {j.owner_name && <span>Owner: {j.owner_name}</span>}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span>
                  Page {page} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <JourneyBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        journeyId={editingId}
        lookups={lookups}
        onSaved={refresh}
      />
      <JourneyDetail
        journeyId={detailId}
        open={detailId != null}
        onOpenChange={(o) => !o && setDetailId(null)}
        canManage={canManage}
        onEdit={(id) => {
          setDetailId(null)
          openEdit(id)
        }}
        onChanged={refresh}
      />
    </main>
  )
}

/** Compact preview of a journey's step sequence, loaded lazily per card. */
function StepChips({ journeyId, stepCount }: { journeyId: number; stepCount: number }) {
  const { data } = useSWR(stepCount > 0 ? `/api/marketing/journeys/${journeyId}` : null, fetcher)
  const steps: any[] = data?.steps || []

  if (stepCount === 0) {
    return <p className="text-xs text-muted-foreground">No steps yet — edit this journey to add its flow.</p>
  }
  if (steps.length === 0) {
    return <div className="h-6 w-40 animate-pulse rounded bg-muted" />
  }

  const shown = steps.slice(0, 6)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((s, i) => {
        const meta = STEP_META[s.type as StepType]
        const Icon = meta?.icon || Workflow
        return (
          <div key={s.id} className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
              <Icon className="size-3.5 text-primary" />
              <span className="text-xs">{s.name || meta?.label || s.type}</span>
            </div>
            {i < shown.length - 1 && <span className="text-muted-foreground">&rarr;</span>}
          </div>
        )
      })}
      {steps.length > shown.length && (
        <span className="text-xs text-muted-foreground">+{steps.length - shown.length} more</span>
      )}
    </div>
  )
}
