"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Upload } from "lucide-react"
import { readExcelFile, mapRow, downloadExcelTemplate } from "@/lib/excel-import"

export function ExcelImportButton<T extends string>({
  endpoint,
  aliases,
  templateFilename,
  templateHeaders,
  templateSample,
  onImported,
}: {
  endpoint: string
  aliases: Record<T, string[]>
  templateFilename: string
  templateHeaders: string[]
  templateSample?: string[]
  onImported: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  async function handleFile(file: File) {
    setImporting(true)
    try {
      const rawRows = await readExcelFile(file)
      if (rawRows.length === 0) {
        toast.error("The file has no data rows")
        return
      }
      const rows = rawRows.map((row) => mapRow(row, aliases))
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(result.error || "Import failed")
        return
      }
      if (result.imported > 0) {
        toast.success(`Imported ${result.imported} row${result.imported === 1 ? "" : "s"}`)
        onImported()
      }
      if (result.failed > 0) {
        toast.error(`${result.failed} row${result.failed === 1 ? "" : "s"} could not be imported`, {
          description: result.errors?.[0],
        })
      }
    } catch (error) {
      toast.error("Could not read that file. Use .xlsx, .xls, or .csv.")
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ""
        }}
      />
      <Button
        variant="outline"
        disabled={importing}
        onClick={() => {
          if (inputRef.current) inputRef.current.click()
        }}
      >
        <Upload data-icon="inline-start" />
        {importing ? "Importing..." : "Import"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => downloadExcelTemplate(templateFilename, templateHeaders, templateSample)}
      >
        Template
      </Button>
    </>
  )
}
