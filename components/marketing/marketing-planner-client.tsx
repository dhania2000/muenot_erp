"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MarketingHeader } from "@/components/marketing/marketing-shared"
import { Plus, Search, LayoutGrid, CalendarDays, List, BarChart3, AlertTriangle, X, Loader2 } from "lucide-react"
import { PLANNER_STATUSES, PLANNER_PRIORITIES } from "@/lib/marketing/planner-constants"
import { plannerFetch, type Lookups, type ListResponse, type PlannerItem } from "./planner/planner-shared"
import { PlannerItemDialog } from "./planner/planner-item-dialog"
import { PlannerDetailSheet } from "./planner/planner-detail-sheet"
import { PlannerBoard } from "./planner/planner-board"
import { PlannerCalendar } from "./planner/planner-calendar"
import { PlannerList } from "./planner/planner-list"
import { PlannerAnalytics } from "./planner/planner-analytics"

const fetcher = (url: string) => plannerFetch(url)
const ALL = "all"

type Perms = {
  canManage: boolean
  canPublish: boolean
  canApprove: boolean
  canAssign: boolean
}

export function MarketingPlannerClient({ perms }: { perms?: Partial<Perms> }) {
  const permissions: Perms = {
    canManage: perms?.canManage ?? true,
    canPublish: perms?.canPublish ?? true,
    canApprove: perms?.canApprove ?? true,
    canAssign: perms?.canAssign ?? true,
  }

  const [view, setView] = useState("board")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState(ALL)
  const [priority, setPriority] = useState(ALL)
  const [channel, setChannel] = useState(ALL)
  const [owner, setOwner] = useState(ALL)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [scope, setScope] = useState(ALL)

  // List-view specific state
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState("updated_at")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const pageSize = 25

  // Dialog / sheet state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PlannerItem | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const { data: lookups } = useSWR<Lookups>("/api/marketing/planner/lookups", fetcher)

  // For board & calendar we want the full set (no pagination); for list we page.
  const listMode = view === "list"

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    if (search.trim()) p.set("search", search.trim())
    if (status !== ALL) p.set("status", status)
    if (priority !== ALL) p.set("priority", priority)
    if (channel !== ALL) p.set("channel", channel)
    if (owner !== ALL) p.set("owner_id", owner)
    if (overdueOnly) p.set("overdueOnly", "1")
    if (scope === "mine") p.set("scope", "mine")
    if (listMode) {
      p.set("page", String(page + 1))
      p.set("pageSize", String(pageSize))
      p.set("sort", sort)
      p.set("dir", dir)
    } else {
      p.set("pageSize", "500")
    }
    return p.toString()
  }, [search, status, priority, channel, owner, overdueOnly, scope, listMode, page, sort, dir])

  const analyticsQuery = useMemo(() => {
    const p = new URLSearchParams()
    if (channel !== ALL) p.set("channel", channel)
    if (owner !== ALL) p.set("owner_id", owner)
    if (scope === "mine") p.set("scope", "mine")
    return p.toString()
  }, [channel, owner, scope])

  const showList = view !== "analytics"
  const { data, isLoading, mutate } = useSWR<ListResponse>(
    showList ? `/api/marketing/planner?${queryString}` : null,
    fetcher,
    { keepPreviousData: true },
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const summary = data?.summary

  const activeFilters =
    (status !== ALL ? 1 : 0) +
    (priority !== ALL ? 1 : 0) +
    (channel !== ALL ? 1 : 0) +
    (owner !== ALL ? 1 : 0) +
    (overdueOnly ? 1 : 0) +
    (scope !== ALL ? 1 : 0)

  function resetFilters() {
    setStatus(ALL)
    setPriority(ALL)
    setChannel(ALL)
    setOwner(ALL)
    setOverdueOnly(false)
    setScope(ALL)
    setPage(0)
  }

  function openDetail(item: PlannerItem) {
    setDetailId(item.id)
    setDetailOpen(true)
  }

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(item: PlannerItem) {
    setEditing(item)
    setDialogOpen(true)
  }

  function handleSort(key: string) {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSort(key)
      setDir("asc")
    }
    setPage(0)
  }

  const channelOptions = lookups?.channels ?? []

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Marketing Planner"
        description="Plan and schedule content across channels — from backlog idea to published, with reviews, assignments and analytics."
        action={
          permissions.canManage ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              Add item
            </Button>
          ) : undefined
        }
      />

      <Tabs value={view} onValueChange={(v) => setView(v)} className="gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="board">
                <LayoutGrid className="size-4" /> Board
              </TabsTrigger>
              <TabsTrigger value="calendar">
                <CalendarDays className="size-4" /> Calendar
              </TabsTrigger>
              <TabsTrigger value="list">
                <List className="size-4" /> List
              </TabsTrigger>
              <TabsTrigger value="analytics">
                <BarChart3 className="size-4" /> Analytics
              </TabsTrigger>
            </TabsList>

            {summary ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{summary.total} items</span>
                {summary.overdue > 0 ? (
                  <span className="flex items-center gap-1 font-medium text-destructive">
                    <AlertTriangle className="size-3" />
                    {summary.overdue} overdue
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
                placeholder="Search title, code, description…"
                className="pl-8"
              />
            </div>

            <FilterSelect value={status} onChange={setStatus} placeholder="Status" width="w-[140px]">
              {PLANNER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </FilterSelect>

            <FilterSelect value={priority} onChange={setPriority} placeholder="Priority" width="w-[130px]">
              {PLANNER_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </FilterSelect>

            <FilterSelect value={channel} onChange={setChannel} placeholder="Channel" width="w-[140px]">
              {channelOptions.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </FilterSelect>

            <FilterSelect value={owner} onChange={setOwner} placeholder="Owner" width="w-[150px]">
              {(lookups?.employees ?? []).map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.name}
                </SelectItem>
              ))}
            </FilterSelect>

            <Button
              variant={overdueOnly ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setOverdueOnly((v) => !v)
                setPage(0)
              }}
            >
              <AlertTriangle className="size-3.5" />
              Overdue
            </Button>

            <Button
              variant={scope === "mine" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setScope((s) => (s === "mine" ? ALL : "mine"))
                setPage(0)
              }}
            >
              My items
            </Button>

            {activeFilters > 0 ? (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                <X className="size-3.5" />
                Clear ({activeFilters})
              </Button>
            ) : null}
          </div>
        </div>

        <TabsContent value="board">
          <ViewFrame isLoading={isLoading && items.length === 0}>
            <PlannerBoard
              items={items}
              canManage={permissions.canManage}
              onOpen={openDetail}
              onMutated={() => mutate()}
            />
          </ViewFrame>
        </TabsContent>

        <TabsContent value="calendar">
          <ViewFrame isLoading={isLoading && items.length === 0}>
            <PlannerCalendar items={items} onOpen={openDetail} />
          </ViewFrame>
        </TabsContent>

        <TabsContent value="list">
          <ViewFrame isLoading={isLoading && items.length === 0}>
            <PlannerList
              items={items}
              total={total}
              page={page}
              pageSize={pageSize}
              sort={sort}
              dir={dir}
              onSort={handleSort}
              onPage={setPage}
              onOpen={openDetail}
            />
          </ViewFrame>
        </TabsContent>

        <TabsContent value="analytics">
          <PlannerAnalytics query={analyticsQuery} />
        </TabsContent>
      </Tabs>

      <PlannerItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        lookups={lookups}
        item={editing}
        onSaved={() => mutate()}
      />

      <PlannerDetailSheet
        itemId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        lookups={lookups}
        perms={permissions}
        onEdit={(item) => {
          setDetailOpen(false)
          openEdit(item)
        }}
        onMutated={() => mutate()}
      />
    </main>
  )
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  width,
  children,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  width: string
  children: React.ReactNode
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={width}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}: All</SelectItem>
        {children}
      </SelectContent>
    </Select>
  )
}

function ViewFrame({ isLoading, children }: { isLoading: boolean; children: React.ReactNode }) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return <>{children}</>
}
