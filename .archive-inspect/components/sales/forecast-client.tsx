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
import { ForecastDialog } from "@/components/sales/forecast-dialog"

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

  async function deleteForecast(forecast: ForecastRow) {
    if (!confirm(`Delete forecast ${forecast.forecast_code}?`)) return
    const res = await fetch(`/api/sales/forecast/${forecast.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Forecast deleted")
      mutate()
    } else {
      toast.error("Unable to delete forecast")
    }
  }

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

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
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
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Loading forecast...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && forecasts.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No forecast records found.
                </TableCell>
              </TableRow>
            )}
            {forecasts.map((forecast) => (
              <TableRow key={forecast.id}>
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
                        <DropdownMenuItem variant="destructive" onClick={() => deleteForecast(forecast)}>
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
    </div>
  )
}
