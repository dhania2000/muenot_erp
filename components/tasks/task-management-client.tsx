"use client"

import { useMemo, useState, useEffect } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty } from "@/components/ui/empty"
import { Plus, Search, AlertTriangle, Lock, CalendarClock, RefreshCw, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { TaskFormDialog } from "./task-form-dialog"
import { TaskDetailSheet } from "./task-detail-sheet"
import { PRIORITY_TONE, STATUS_TONE, formatDate, isOverdue } from "./task-shared"
import type { TaskMeta, TaskListItem } from "./task-shared"

const STATUS_COLUMNS = ["To Do", "In Progress", "Blocked", "In Review", "Done"] as const

export function TaskManagementClient({
  currentUserId,
  currentUserName,
}: {
  currentUserId: number
  currentUserName: string
}) {
  const [view, setView] = useState<"all" | "mine" | "reported">("all")
  const [layout, setLayout] = useState<"list" | "board">("list")
  const [status, setStatus] = useState<string>("")
  const [priority, setPriority] = useState<string>("")
  const [q, setQ] = useState("")
  const [overdue, setOverdue] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [activeId, setActiveId] = useState<number | null>(null)

  // Deep-link support: /modules/tasks?task=123 opens that task.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = Number(params.get("task"))
    if (Number.isSafeInteger(t) && t > 0) setActiveId(t)
  }, [])

  const { data: meta } = useSWR<TaskMeta>("/api/tasks/meta", fetcher)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set("view", view)
    if (status) sp.set("status", status)
    if (priority) sp.set("priority", priority)
    if (q.trim()) sp.set("q", q.trim())
    if (overdue) sp.set("overdue", "1")
    return sp.toString()
  }, [view, status, priority, q, overdue])

  const { data, isLoading, mutate } = useSWR<{ rows: TaskListItem[] }>(
    `/api/tasks?${queryString}`,
    fetcher,
  )
  const rows = data?.rows ?? []

  const counts = useMemo(() => {
    const c = { open: 0, overdue: 0, blocked: 0, review: 0 }
    for (const r of rows) {
      if (r.status !== "Done" && r.status !== "Cancelled") c.open++
      if (r.blocked) c.blocked++
      if (r.status === "In Review") c.review++
      if (isOverdue(r.due_date, r.status)) c.overdue++
    }
    return c
  }, [rows])

  function refresh() {
    mutate()
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Tasks</h1>
            <p className="text-sm text-muted-foreground">
              Centralized task engine — assignees, teams, dependencies, approvals, and recurrence.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New task
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Open" value={counts.open} icon={<CalendarClock className="size-4 text-muted-foreground" />} />
          <StatCard label="Overdue" value={counts.overdue} icon={<AlertTriangle className="size-4 text-destructive" />} />
          <StatCard label="Blocked" value={counts.blocked} icon={<Lock className="size-4 text-amber-600" />} />
          <StatCard label="In review" value={counts.review} icon={<ShieldCheck className="size-4 text-blue-600" />} />
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="mine">Assigned to me</TabsTrigger>
              <TabsTrigger value="reported">Reported by me</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2">
            <Tabs value={layout} onValueChange={(v) => setLayout(v as typeof layout)}>
              <TabsList>
                <TabsTrigger value="list">List</TabsTrigger>
                <TabsTrigger value="board">Board</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="outline" size="icon" onClick={refresh} aria-label="Refresh">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-52">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title or description"
              className="pl-8"
            />
          </div>
          <FilterSelect value={status} onChange={setStatus} placeholder="Status" options={meta?.statuses ?? []} />
          <FilterSelect value={priority} onChange={setPriority} placeholder="Priority" options={meta?.priorities ?? []} />
          <Button
            variant={overdue ? "default" : "outline"}
            onClick={() => setOverdue((v) => !v)}
            className="gap-1.5"
          >
            <AlertTriangle className="size-4" />
            Overdue
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Empty
          title="No tasks found"
          description="Adjust your filters or create the first task for your team."
        />
      ) : layout === "board" ? (
        <BoardView rows={rows} onOpen={setActiveId} />
      ) : (
        <ListView rows={rows} onOpen={setActiveId} />
      )}

      <TaskFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        meta={meta}
        onSaved={() => {
          setCreateOpen(false)
          mutate()
        }}
      />

      {activeId != null && (
        <TaskDetailSheet
          taskId={activeId}
          meta={meta}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          onClose={() => setActiveId(null)}
          onChanged={() => mutate()}
        />
      )}
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card className="flex items-center justify-between gap-2 p-3">
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold text-foreground">{value}</div>
      </div>
      {icon}
    </Card>
  )
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: readonly string[]
}) {
  return (
    <Select value={value || "__all"} onValueChange={(v) => onChange(v === "__all" ? "" : v)}>
      <SelectTrigger className="w-36">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">All {placeholder.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TaskRowMeta({ task }: { task: TaskListItem }) {
  const overdueFlag = isOverdue(task.due_date, task.status)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {task.assignee_name ? <span>{task.assignee_name}</span> : <span className="italic">Unassigned</span>}
      {task.team_name && <span>· {task.team_name}</span>}
      {task.due_date && (
        <span className={overdueFlag ? "font-medium text-destructive" : ""}>
          · Due {formatDate(task.due_date)}
        </span>
      )}
      {task.recurrence && task.recurrence !== "none" && (
        <span className="inline-flex items-center gap-1">
          · <RefreshCw className="size-3" /> {task.recurrence}
        </span>
      )}
      {task.approval_required === 1 && task.approval_status !== "approved" && (
        <span className="inline-flex items-center gap-1">
          · <ShieldCheck className="size-3" /> {task.approval_status}
        </span>
      )}
    </div>
  )
}

function ListView({ rows, onOpen }: { rows: TaskListItem[]; onOpen: (id: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((task) => (
        <Card
          key={task.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(task.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onOpen(task.id)
            }
          }}
          className="flex cursor-pointer items-start justify-between gap-3 p-3 transition-colors hover:bg-accent/50"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              {task.blocked && <Lock className="size-3.5 shrink-0 text-amber-600" aria-label="Blocked" />}
              <span className="truncate font-medium text-foreground">{task.title}</span>
            </div>
            <TaskRowMeta task={task} />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge variant="outline" className={PRIORITY_TONE[task.priority] ?? ""}>
              {task.priority}
            </Badge>
            <Badge variant="outline" className={STATUS_TONE[task.status] ?? ""}>
              {task.status}
            </Badge>
          </div>
        </Card>
      ))}
    </div>
  )
}

function BoardView({ rows, onOpen }: { rows: TaskListItem[]; onOpen: (id: number) => void }) {
  const grouped = useMemo(() => {
    const g: Record<string, TaskListItem[]> = {}
    for (const col of STATUS_COLUMNS) g[col] = []
    for (const r of rows) {
      if (g[r.status]) g[r.status].push(r)
    }
    return g
  }, [rows])

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {STATUS_COLUMNS.map((col) => (
        <div key={col} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-sm font-medium text-foreground">{col}</span>
            <Badge variant="secondary">{grouped[col].length}</Badge>
          </div>
          <div className="flex flex-col gap-2">
            {grouped[col].map((task) => (
              <Card
                key={task.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(task.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onOpen(task.id)
                  }
                }}
                className="flex cursor-pointer flex-col gap-2 p-2.5 transition-colors hover:bg-accent/50"
              >
                <div className="flex items-start gap-1.5">
                  {task.blocked && <Lock className="mt-0.5 size-3 shrink-0 text-amber-600" aria-label="Blocked" />}
                  <span className="text-sm font-medium leading-snug text-foreground">{task.title}</span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className={PRIORITY_TONE[task.priority] ?? ""}>
                    {task.priority}
                  </Badge>
                  {task.due_date && (
                    <span
                      className={
                        isOverdue(task.due_date, task.status)
                          ? "text-xs font-medium text-destructive"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {formatDate(task.due_date)}
                    </span>
                  )}
                </div>
                {task.assignee_name && (
                  <span className="truncate text-xs text-muted-foreground">{task.assignee_name}</span>
                )}
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
