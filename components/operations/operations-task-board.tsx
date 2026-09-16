"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { CalendarDays, User, FolderKanban, GripVertical } from "lucide-react"

// The board is an alternate lens over the same `operations_tasks` records used
// by the Tasks table — it never creates a duplicate data source. Columns map to
// the `board_stage` field; dropping a card writes the new stage back via PUT.
const STAGES = ["Backlog", "To Do", "In Progress", "In Review", "Done"] as const
type Stage = (typeof STAGES)[number]

const PRIORITY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Critical: "destructive",
  High: "destructive",
  Medium: "secondary",
  Low: "outline",
}

type Task = {
  id: number
  task_title?: string
  project_name?: string
  project_id?: string
  client_name?: string
  assigned_to?: string
  resource_name?: string
  priority?: string
  due_date?: string
  completion_percent?: number | string
  board_stage?: string
  status?: string
}

// Tasks whose board_stage is empty or unrecognised fall into the first column
// so nothing is ever hidden from the board.
function stageOf(task: Task): Stage {
  const s = (task.board_stage || "").trim()
  return (STAGES as readonly string[]).includes(s) ? (s as Stage) : STAGES[0]
}

export function OperationsTaskBoard() {
  const { data, mutate, isLoading } = useSWR<{ rows: Task[] }>("/api/operations?kind=tasks", fetcher)
  const [dragId, setDragId] = useState<number | null>(null)
  const [overStage, setOverStage] = useState<Stage | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)

  const tasks = useMemo(() => data?.rows ?? [], [data])

  const byStage = useMemo(() => {
    const map: Record<Stage, Task[]> = { Backlog: [], "To Do": [], "In Progress": [], "In Review": [], Done: [] }
    for (const t of tasks) map[stageOf(t)].push(t)
    return map
  }, [tasks])

  async function moveTo(task: Task, stage: Stage) {
    if (stageOf(task) === stage) return
    setSavingId(task.id)
    // Optimistically reflect the move while the PUT is in flight.
    await mutate(
      async () => {
        await fetch("/api/operations", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "tasks", id: task.id, board_stage: stage }),
        })
        return undefined // trigger revalidation
      },
      {
        optimisticData: {
          rows: tasks.map((t) => (t.id === task.id ? { ...t, board_stage: stage } : t)),
        },
        rollbackOnError: true,
        populateCache: false,
        revalidate: true,
      },
    ).finally(() => setSavingId(null))
  }

  function onDrop(stage: Stage) {
    setOverStage(null)
    const id = dragId
    setDragId(null)
    if (id == null) return
    const task = tasks.find((t) => t.id === id)
    if (task) void moveTo(task, stage)
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading task board...</div>
  }

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Delivery cockpit</p>
          <h1 className="text-3xl font-semibold tracking-tight">Task Board</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag a task between stages to update its board stage. Cards are the same records as the Tasks list.
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {STAGES.map((stage) => {
          const items = byStage[stage]
          const isOver = overStage === stage
          return (
            <section
              key={stage}
              onDragOver={(e) => {
                e.preventDefault()
                if (overStage !== stage) setOverStage(stage)
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the column, not when moving over children.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage((s) => (s === stage ? null : s))
              }}
              onDrop={() => onDrop(stage)}
              className={`flex min-h-64 flex-col gap-3 rounded-xl border bg-muted/30 p-3 transition-colors ${
                isOver ? "border-primary bg-primary/5" : ""
              }`}
              aria-label={`${stage} column`}
            >
              <header className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold">{stage}</h2>
                <Badge variant="secondary" className="text-xs">
                  {items.length}
                </Badge>
              </header>

              <div className="flex flex-col gap-3">
                {items.length === 0 && (
                  <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                    Drop tasks here
                  </p>
                )}
                {items.map((task) => (
                  <Card
                    key={task.id}
                    draggable
                    onDragStart={() => setDragId(task.id)}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverStage(null)
                    }}
                    className={`group cursor-grab gap-2 p-3 active:cursor-grabbing ${
                      savingId === task.id ? "opacity-60" : ""
                    } ${dragId === task.id ? "ring-2 ring-primary" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <GripVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <p className="text-sm font-medium leading-snug">
                          {task.task_title || `Task #${task.id}`}
                        </p>
                        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {(task.project_name || task.project_id) && (
                            <span className="flex items-center gap-1.5">
                              <FolderKanban className="size-3.5 shrink-0" />
                              <span className="truncate">{task.project_name || task.project_id}</span>
                            </span>
                          )}
                          {(task.resource_name || task.assigned_to) && (
                            <span className="flex items-center gap-1.5">
                              <User className="size-3.5 shrink-0" />
                              <span className="truncate">{task.resource_name || task.assigned_to}</span>
                            </span>
                          )}
                          {task.due_date && (
                            <span className="flex items-center gap-1.5">
                              <CalendarDays className="size-3.5 shrink-0" />
                              <span>{task.due_date}</span>
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {task.priority && (
                            <Badge variant={PRIORITY_VARIANT[task.priority] ?? "outline"} className="text-[10px]">
                              {task.priority}
                            </Badge>
                          )}
                          {task.client_name && (
                            <Badge variant="outline" className="text-[10px]">
                              {task.client_name}
                            </Badge>
                          )}
                          {task.completion_percent != null && String(task.completion_percent).trim() !== "" && (
                            <span className="text-[10px] text-muted-foreground">{task.completion_percent}%</span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1 pt-1">
                          {STAGES.filter((s) => s !== stageOf(task)).map((s) => (
                            <Button
                              key={s}
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[10px] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                              onClick={() => moveTo(task, s)}
                              disabled={savingId === task.id}
                            >
                              → {s}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </main>
  )
}
