"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ArrowDown, ArrowUp, ChevronsUpDown, Clock } from "lucide-react"
import { StatusBadge, PriorityBadge, fmtDate, type PlannerItem } from "./planner-shared"

type SortKey = "title" | "status" | "priority" | "due_date" | "updated_at" | "channel"

const COLUMNS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: "title", label: "Title" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "channel", label: "Channel" },
  { key: null, label: "Owner / Assignee" },
  { key: "due_date", label: "Due" },
  { key: "updated_at", label: "Updated" },
]

export function PlannerList({
  items,
  total,
  page,
  pageSize,
  sort,
  dir,
  onSort,
  onPage,
  onOpen,
}: {
  items: PlannerItem[]
  total: number
  page: number
  pageSize: number
  sort: string
  dir: "asc" | "desc"
  onSort: (key: SortKey) => void
  onPage: (page: number) => void
  onOpen: (item: PlannerItem) => void
}) {
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              {COLUMNS.map((c) => (
                <th key={c.label} className={cn("px-3 py-2 font-medium text-muted-foreground", c.className)}>
                  {c.key ? (
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => onSort(c.key!)}
                    >
                      {c.label}
                      {sort === c.key ? (
                        dir === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-10 text-center text-muted-foreground">
                  No items match the current filters.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                  onClick={() => onOpen(item)}
                >
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <span className="font-medium text-pretty">{item.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{item.item_code}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="px-3 py-2">
                    <PriorityBadge priority={item.priority} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{item.channel}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {item.assignee_name || item.owner_name || "Unassigned"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "flex items-center gap-1 whitespace-nowrap",
                        item.is_overdue ? "font-medium text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {item.is_overdue ? <Clock className="size-3" /> : null}
                      {fmtDate(item.due_date)}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtDate(item.updated_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {from}–{to} of {total}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 0} onClick={() => onPage(page - 1)}>
            Previous
          </Button>
          <span className="tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => onPage(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
