"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DATE_PRESETS, resolveDatePreset } from "@/lib/dashboards/types"
import type { DashboardFilters } from "@/lib/dashboards/types"

export function DashboardFilterBar({
  filters,
  departments,
  onChange,
}: {
  filters: DashboardFilters
  departments: string[]
  onChange: (next: DashboardFilters) => void
}) {
  function setPreset(preset: string) {
    if (preset === "custom") {
      onChange({ ...filters, preset })
      return
    }
    const { from, to } = resolveDatePreset(preset)
    onChange({ ...filters, preset, from, to })
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Date range</Label>
        <Select value={filters.preset} onValueChange={setPreset}>
          <SelectTrigger className="h-9 w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filters.preset === "custom" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="df-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="df-from"
              type="date"
              className="h-9 w-[150px]"
              value={filters.from ?? ""}
              onChange={(e) => onChange({ ...filters, from: e.target.value || null })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="df-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="df-to"
              type="date"
              className="h-9 w-[150px]"
              value={filters.to ?? ""}
              onChange={(e) => onChange({ ...filters, to: e.target.value || null })}
            />
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Department</Label>
        <Select
          value={filters.department ?? "all"}
          onValueChange={(v) => onChange({ ...filters, department: v === "all" ? null : v })}
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
