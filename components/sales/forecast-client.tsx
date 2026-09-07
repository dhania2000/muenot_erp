"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatCurrency } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { ForecastDialog } from "@/components/sales/forecast-dialog"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

export type ForecastRow = {
  id: number
  forecast_code: string
  forecast_date: string | null
  quarter: string
  year: number
  expected_revenue: number
  best_case: number
  worst_case: number
  pipeline_coverage: string | null
  owner: string | null
  created_at: string
}

const COVERAGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Low: "destructive",
  Medium: "secondary",
  High: "default",
  "On Track": "default",
}

export function ForecastClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ forecast: ForecastRow[] }>("/api/sales/forecast", fetcher)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ForecastRow | null>(null)

  const forecasts = data?.forecast ?? []

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/forecast/${id}`,
    labels: { singular: "forecast", plural: "forecasts" },
    mutate,
    onDeleted: clear,
  })

  const colSpan = canManage ? 8 : 6

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Quarterly revenue forecast</h2>
          <p className="text-xs text-muted-foreground">Expected, best-case, and worst-case revenue by quarter.</p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Add forecast
          </Button>
        )}
      </div>

      {canManage && (
        <SelectionToolbar
          count={selected.size}
          noun="forecast"
          onClear={clear}
          onDelete={() => del.requestBulk([...selected])}
        />
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {canManage && (
                <TableHead className="w-10">
                  <SelectAllCheckbox ids={forecasts.map((f) => f.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Quarter</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Best case</TableHead>
              <TableHead>Worst case</TableHead>
              <TableHead>Coverage</TableHead>
              <TableHead>Owner</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
                  Loading forecast...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && forecasts.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
                  No forecast records found.
                </TableCell>
              </TableRow>
            )}
            {forecasts.map((forecast) => (
              <TableRow key={forecast.id} data-state={selected.has(forecast.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select forecast ${forecast.forecast_code}`}
                      checked={selected.has(forecast.id)}
                      onCheckedChange={() => toggle(forecast.id)}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  {forecast.quarter} {forecast.year}
                </TableCell>
                <TableCell className="font-medium">{formatCurrency(forecast.expected_revenue)}</TableCell>
                <TableCell className="text-muted-foreground">{formatCurrency(forecast.best_case)}</TableCell>
                <TableCell className="text-muted-foreground">{formatCurrency(forecast.worst_case)}</TableCell>
                <TableCell>
                  {forecast.pipeline_coverage ? (
                    <Badge variant={COVERAGE_VARIANT[forecast.pipeline_coverage] || "outline"}>
                      {forecast.pipeline_coverage}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{forecast.owner || "—"}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(forecast)
                            setDialogOpen(true)
                          }}
                        >
                          Edit forecast
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            del.requestSingle(forecast.id, `forecast ${forecast.forecast_code}`)
                          }
                        >
                          Delete forecast
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ForecastDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        forecast={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Forecast updated" : "Forecast added")
          mutate()
        }}
      />

      {del.dialog}
    </div>
  )
}
