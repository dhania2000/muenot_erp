"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatHours, formatTime, statusVariant } from "@/lib/attendance-ui"

type EmployeeOption = { id: number; employee_id: string; employee_name: string }

type MonthlyDay = {
  date: string
  status: string
  flags: string[]
  clock_in: string | null
  clock_out: string | null
  working_hours: number
  late_minutes: number
  overtime_hours: number
  holiday_name: string | null
  is_manual_override: boolean
}

type MonthlyResponse = {
  employee: { employee_id: string; employee_name: string; department: string | null; designation: string | null }
  month: string
  shift: { shift_name: string; start_time: string; end_time: string } | null
  hasShift: boolean
  days: MonthlyDay[]
  totals: {
    present: number
    absent: number
    leave: number
    holiday: number
    weeklyOff: number
    late: number
    workingHours: number
    overtime: number
  }
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

export function AttendanceMonthly({ employees }: { employees: EmployeeOption[] }) {
  const [employeeId, setEmployeeId] = useState<string>("")
  const [month, setMonth] = useState<string>(currentMonth())

  const key = employeeId ? `/api/hr/attendance/monthly?employeeId=${employeeId}&month=${month}` : null
  const { data, isLoading } = useSWR<MonthlyResponse>(key, fetcher)

  const totals = data?.totals

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div className="min-w-[220px] flex-1">
          <Label className="mb-1.5 block text-xs">Employee</Label>
          <Select value={employeeId} onValueChange={(v) => setEmployeeId(v || "")}>
            <SelectTrigger>
              <SelectValue placeholder="Select an employee" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.employee_id} · {e.employee_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1.5 block text-xs" htmlFor="monthly-month">
            Month
          </Label>
          <Input
            id="monthly-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-[180px]"
          />
        </div>
      </div>

      {!employeeId && (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Select an employee to view their monthly attendance.
        </p>
      )}

      {employeeId && isLoading && (
        <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">
                {data.employee.employee_name}{" "}
                <span className="text-muted-foreground">({data.employee.employee_id})</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {[data.employee.designation, data.employee.department].filter(Boolean).join(" · ") || "—"}
                {data.shift ? ` · ${data.shift.shift_name} (${formatTime(data.shift.start_time)}–${formatTime(data.shift.end_time)})` : ""}
              </p>
            </div>
            {!data.hasShift && (
              <Badge variant="destructive">No shift assigned</Badge>
            )}
          </div>

          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {[
                ["Present", totals.present],
                ["Absent", totals.absent],
                ["Leave", totals.leave],
                ["Holiday", totals.holiday],
                ["Weekly Off", totals.weeklyOff],
                ["Late Days", totals.late],
                ["Work Hrs", formatHours(totals.workingHours)],
                ["Overtime", formatHours(totals.overtime)],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border bg-card p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="p-3">Date</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">In / Out</th>
                  <th className="p-3">Hours</th>
                  <th className="p-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((day) => (
                  <tr key={day.date} className="border-b last:border-0">
                    <td className="p-3 tabular-nums">{day.date.slice(8)}</td>
                    <td className="p-3">
                      <Badge variant={statusVariant(day.status)}>{day.status}</Badge>
                    </td>
                    <td className="p-3 tabular-nums text-muted-foreground">
                      {formatTime(day.clock_in)} / {formatTime(day.clock_out)}
                    </td>
                    <td className="p-3">{day.working_hours > 0 ? formatHours(day.working_hours) : "—"}</td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {day.holiday_name ? day.holiday_name : null}
                      {day.late_minutes > 0 ? ` Late ${day.late_minutes}m` : ""}
                      {day.overtime_hours > 0 ? ` OT ${formatHours(day.overtime_hours)}` : ""}
                      {day.is_manual_override ? " (override)" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
