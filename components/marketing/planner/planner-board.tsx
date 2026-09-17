"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CalendarDays, GripVertical, Clock } from "lucide-react"
import {
  BOARD_COLUMNS,
  COLUMN_DEFAULT_STATUS,
  canTransition,
  type BoardColumn,
} from "@/lib/marketing/planner-constants"
import { StatusBadge, PriorityBadge, fmtDate, plannerFetch, type PlannerItem } from "./planner-shared"

const COLUMN_HINT: Record<BoardColumn, string> = {
  Backlog: "Ideas & drafts",
  Planned: "Scheduled & assigned",
  "In Progress": "Being worked on",
  Published: "Live & completed",
}

export function PlannerBoard({
  items,
  canManage,
  onOpen,
  onMutated,
}: {
  items: PlannerItem[]
  canManage: boolean
  onOpen: (item: PlannerItem) => void
  onMutated: () => void
}) {
  const [dragId, setDragId] = useState<number | null>(null)
  const [overCol, setOverCol] = useState<BoardColumn | null>(null)

  async function moveTo(item: PlannerItem, col: BoardColumn) {
    const to = COLUMN_DEFAULT_STATUS[col]
    if (item.status === to || item.board_column === col) return
    if (!canTransition(item.status, to)) {
      toast.error(`Can't move ${item.item_code} from ${item.status} to ${to}`)
      return
    }
    try {
      if (to === "Published") {
        await plannerFetch(`/api/marketing/planner/${item.id}/publish`, {
          method: "POST",
          body: JSON.stringify({}),
        })
      } else {
        await plannerFetch(`/api/marketing/planner/${item.id}/transition`, {
          method: "POST",
          body: JSON.stringify({ to, row_version: item.row_version }),
        })
      }
      toast.success(`${item.item_code} → ${to}`)
      onMutated()
    } catch (err: any) {
      toast.error(err?.message || "Move failed")
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {BOARD_COLUMNS.map((col) => {
        const colItems = items.filter((i) => i.board_column === col)
        const isOver = overCol === col
        return (
          <div
            key={col}
            className={cn(
              "flex min-h-32 flex-col gap-3 rounded-lg p-2 transition-colors",
              isOver ? "bg-accent" : "bg-muted/40",
            )}
            onDragOver={(e) => {
              if (dragId == null) return
              e.preventDefault()
              setOverCol(col)
            }}
            onDragLeave={() => setOverCol((c) => (c === col ? null : c))}
            onDrop={() => {
              const dragged = items.find((i) => i.id === dragId)
              setOverCol(null)
              setDragId(null)
              if (dragged) moveTo(dragged, col)
            }}
          >
            <div className="flex items-center justify-between px-1">
              <div className="flex flex-col">
                <span className="text-sm font-semibold">{col}</span>
                <span className="text-xs text-muted-foreground">{COLUMN_HINT[col]}</span>
              </div>
              <Badge variant="outline">{colItems.length}</Badge>
            </div>

            <div className="flex flex-col gap-2.5">
              {colItems.map((item) => (
                <Card
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  draggable={canManage}
                  onDragStart={() => setDragId(item.id)}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverCol(null)
                  }}
                  onClick={() => onOpen(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onOpen(item)
                    }
                  }}
                  className={cn(
                    "group cursor-pointer gap-2 p-3 transition-shadow hover:shadow-md",
                    dragId === item.id && "opacity-50",
                    item.is_overdue && "ring-1 ring-destructive/40",
                  )}
                  style={item.color ? { borderLeft: `3px solid ${item.color}` } : undefined}
                >
                  <div className="flex items-start gap-1.5">
                    {canManage ? (
                      <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
                    ) : null}
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <p className="text-sm leading-snug font-medium text-pretty">{item.title}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="text-[11px]">
                          {item.channel}
                        </Badge>
                        <PriorityBadge priority={item.priority} />
                        {item.status !== COLUMN_DEFAULT_STATUS[col] ? <StatusBadge status={item.status} /> : null}
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="truncate">{item.assignee_name || item.owner_name || "Unassigned"}</span>
                        {item.due_date ? (
                          <span
                            className={cn(
                              "flex items-center gap-1",
                              item.is_overdue && "font-medium text-destructive",
                            )}
                          >
                            {item.is_overdue ? <Clock className="size-3" /> : <CalendarDays className="size-3" />}
                            {fmtDate(item.due_date)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
              {colItems.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {canManage ? "Drop items here" : "Nothing here"}
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
