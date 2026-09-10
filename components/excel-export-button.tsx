"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"
import { exportRowsToExcel, type ExportColumn } from "@/lib/excel-export"

/**
 * Reusable "Export" button that downloads the given rows as an .xlsx file.
 *
 * Pass the full in-memory dataset as `rows` (not just the page that is
 * visible) so the export always contains every record. Provide `columns`
 * to control which fields and headers are written; otherwise columns are
 * inferred from the first row's keys.
 */
export function ExcelExportButton<T extends Record<string, unknown>>({
  rows,
  filename,
  columns,
  label = "Export",
  disabled,
  variant = "outline",
  size = "default",
}: {
  rows: T[]
  filename: string
  columns?: ExportColumn<T>[]
  label?: string
  disabled?: boolean
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
}) {
  const [exporting, setExporting] = useState(false)

  function handleExport() {
    if (!rows || rows.length === 0) {
      toast.error("There is nothing to export yet")
      return
    }
    setExporting(true)
    try {
      exportRowsToExcel(filename, rows, columns)
      toast.success(`Exported ${rows.length} row${rows.length === 1 ? "" : "s"} to Excel`)
    } catch {
      toast.error("Could not export to Excel")
    } finally {
      setExporting(false)
    }
  }

  return (
    <Button variant={variant} size={size} disabled={disabled || exporting} onClick={handleExport}>
      <Download data-icon="inline-start" />
      {exporting ? "Exporting..." : label}
    </Button>
  )
}
