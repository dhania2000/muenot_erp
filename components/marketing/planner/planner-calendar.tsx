"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { StatusBadge, toDateInput, type PlannerItem } from "./planner-shared"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function monthLabel(d: Date) {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" })
}

/** The date an item is anchored to on the calendar: publish date first, else due. */
function anchorDate(item: PlannerItem): string | null {
  if (item.publish_at) return toDateInput(item.publish_at)
  if (item.due_date) return toDateInput(item.due_date)
  return null
}

export function PlannerCalendar({
  items,
  onOpen,
}: {
  items: PlannerItem[]
  onOpen: (item: PlannerItem) => void
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })

  const { cells, byDay } = useMemo(() => {
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const first = new Date(year, month, 1)
    const startOffset = first.getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()

    const cells: (Date | null)[] = []
    for (let i = 0; i < startOffset; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
    while (cells.length % 7 !== 0) cells.push(null)

    const byDay = new Map<string, PlannerItem[]>()
    for (const item of items) {
      const key = anchorDate(item)
      if (!key) continue
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key)!.push(item)
    }
    return { cells, byDay }
  }, [cursor, items])

  const todayKey = toDateInput(new Date().toISOString())

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{monthLabel(cursor)}</h2>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const now = new Date()
              setCursor(new Date(now.getFullYear(), now.getMonth(), 1))
            }}
          >
            Today
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-muted/60 px-2 py-1.5 text-center text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((date, i) => {
          const key = date ? toDateInput(date.toISOString()) : `empty-${i}`
          const dayItems = date ? (byDay.get(key) ?? []) : []
          const isToday = key === todayKey
          return (
            <div
              key={key}
              className={cn(
                "min-h-24 bg-background p-1.5 align-top",
                !date && "bg-muted/20",
                isToday && "bg-primary/5",
              )}
            >
              {date ? (
                <>
                  <div className="mb-1 flex justify-end">
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full text-xs",
                        isToday ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                      )}
                    >
                      {date.getDate()}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {dayItems.slice(0, 3).map((item) => (
                      <button
                        key={item.id}
                        onClick={() => onOpen(item)}
                        className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent"
                        style={item.color ? { borderLeft: `2px solid ${item.color}` } : undefined}
                        title={item.title}
                      >
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: item.color || "var(--color-primary)" }}
                        />
                        <span className="truncate">{item.title}</span>
                      </button>
                    ))}
                    {dayItems.length > 3 ? (
                      <span className="px-1 text-[11px] text-muted-foreground">+{dayItems.length - 3} more</span>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>Items are placed by publish date, falling back to due date.</span>
        <span className="flex items-center gap-1">
          <StatusBadge status="Scheduled" /> scheduled
        </span>
      </div>
    </div>
  )
}
