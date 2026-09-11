"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { fetcher } from "@/lib/fetcher"
import { ChevronLeft, ChevronRight } from "lucide-react"

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function iso(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function LeaveCalendar({ onSelectRequest }: { onSelectRequest: (id: string) => void }) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const { data } = useSWR<any>(`/api/hr/leave-calendar?month=${month}&year=${year}`, fetcher)

  const holidays = useMemo(() => {
    const map = new Map<string, string>()
    for (const h of data?.holidays || []) map.set(h.date, h.name)
    return map
  }, [data])

  // Map each day -> list of leave entries overlapping it.
  const byDay = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const r of data?.requests || []) {
      const start = new Date(`${r.from_date}T00:00:00`)
      const end = new Date(`${r.to_date}T00:00:00`)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getMonth() + 1 !== month || d.getFullYear() !== year) continue
        const key = iso(year, month, d.getDate())
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push(r)
      }
    }
    return map
  }, [data, month, year])

  const firstDow = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  function shift(delta: number) {
    const next = new Date(year, month - 1 + delta, 1)
    setMonth(next.getMonth() + 1)
    setYear(next.getFullYear())
  }

  const statusColor: Record<string, string> = {
    "HR Approved": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    "Manager Approved": "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    Pending: "bg-amber-500/15 text-amber-700 dark:text-amber-500",
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {MONTHS[month - 1]} {year}
        </h3>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => shift(-1)} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setMonth(now.getMonth() + 1); setYear(now.getFullYear()) }}>
            Today
          </Button>
          <Button variant="outline" size="icon" onClick={() => shift(1)} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {DOW.map((d) => (
          <div key={d} className="pb-2 text-center text-xs font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={`empty-${idx}`} />
          const key = iso(year, month, day)
          const entries = byDay.get(key) || []
          const holiday = holidays.get(key)
          const isToday = key === iso(now.getFullYear(), now.getMonth() + 1, now.getDate())
          return (
            <div
              key={key}
              className={`min-h-20 rounded-lg border p-1.5 text-left ${holiday ? "bg-muted/40" : ""} ${isToday ? "border-primary" : "border-border"}`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}>{day}</span>
              </div>
              {holiday && <p className="truncate text-[10px] text-muted-foreground" title={holiday}>{holiday}</p>}
              <div className="mt-1 space-y-0.5">
                {entries.slice(0, 3).map((e) => (
                  <button
                    key={`${key}-${e.request_id}`}
                    onClick={() => onSelectRequest(e.request_id)}
                    className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] ${statusColor[e.status] || "bg-muted text-muted-foreground"}`}
                    title={`${e.employee_name} · ${e.leave_type || ""} · ${e.status}`}
                  >
                    {e.employee_name}
                  </button>
                ))}
                {entries.length > 3 && <p className="px-1 text-[10px] text-muted-foreground">+{entries.length - 3} more</p>}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <Legend className="bg-emerald-500/15" label="HR Approved" />
        <Legend className="bg-blue-500/15" label="Manager Approved" />
        <Legend className="bg-amber-500/15" label="Pending" />
        <Legend className="bg-muted" label="Holiday" />
      </div>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded ${className}`} />
      {label}
    </span>
  )
}
