"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Download, ChevronDown } from "lucide-react"
import { exportRowsToExcel, type ExportColumn } from "@/lib/excel-export"

type DatasetKind = "register" | "detail" | "account" | "voucher" | "period"

const DATASETS: { key: DatasetKind; label: string; hint: string }[] = [
  { key: "register", label: "Journal Register", hint: "One row per voucher" },
  { key: "detail", label: "Journal Detail", hint: "One row per posting line" },
  { key: "account", label: "Account-wise Journal", hint: "Totals per account head" },
  { key: "voucher", label: "Voucher-wise Journal", hint: "Totals per voucher type" },
  { key: "period", label: "Period-wise Journal", hint: "Totals per month" },
]

export type JournalExportFilters = {
  financialYear?: string
  source?: "all" | "manual" | "system"
  search?: string
}

/**
 * The Phase 51 journal exports. Each item pulls a server-built dataset — the
 * Register / Detail / Account-wise / Voucher-wise / Period-wise view of the
 * SAME journal engine the screen lists — honouring the current on-screen
 * filters, then hands the rows to the shared Excel helper. No client-side
 * recomputation: the server owns the numbers.
 */
export function JournalExportMenu({ filters }: { filters: JournalExportFilters }) {
  const [busy, setBusy] = useState<DatasetKind | null>(null)

  async function runExport(kind: DatasetKind, label: string) {
    setBusy(kind)
    try {
      const params = new URLSearchParams({ kind })
      if (filters.financialYear) params.set("financial_year", filters.financialYear)
      if (filters.source && filters.source !== "all") params.set("source", filters.source)
      if (filters.search) params.set("search", filters.search)

      const res = await fetch(`/api/finance/journal-entries/export?${params.toString()}`)
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast.error(json.error || "Could not build the export")
        return
      }
      const dataset = (await res.json()) as {
        columns: { key: string; header: string }[]
        rows: Record<string, unknown>[]
      }
      if (!dataset.rows.length) {
        toast.error("There is nothing to export for the current filters")
        return
      }
      const columns: ExportColumn<Record<string, unknown>>[] = dataset.columns.map((c) => ({
        header: c.header,
        value: (row) => row[c.key],
      }))
      exportRowsToExcel(`journal-${kind}`, dataset.rows, columns)
      toast.success(`Exported ${dataset.rows.length} row${dataset.rows.length === 1 ? "" : "s"} — ${label}`)
    } catch {
      toast.error("Could not build the export")
    } finally {
      setBusy(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy !== null}>
          <Download data-icon="inline-start" />
          {busy ? "Exporting..." : "Export"}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Journal exports</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {DATASETS.map((d) => (
          <DropdownMenuItem
            key={d.key}
            onSelect={(e) => {
              e.preventDefault()
              void runExport(d.key, d.label)
            }}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="font-medium">{d.label}</span>
            <span className="text-xs text-muted-foreground">{d.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
