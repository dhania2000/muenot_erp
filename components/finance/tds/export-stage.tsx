"use client"

import useSWR from "swr"
import { useState } from "react"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, FileSpreadsheet, Package, FileText } from "lucide-react"
import { exportRowsToExcel } from "@/lib/excel-export"
import { currency, Stat, StageHeading, DIRECTION_COPY, type Direction } from "./shared"

type ColumnSpec = { key: string; header: string }
type Dataset = { key: string; label: string; columns: ColumnSpec[]; rows: Record<string, unknown>[] }
type Catalog = { financial_year: string; direction: Direction; datasets: { key: string; label: string }[] }
type CaPackage = {
  financial_year: string
  direction: Direction
  generated_at: string
  deductor: { tan: string; pan: string; name: string; address: string }
  summary: {
    total_base: number
    total_tds: number
    total_deposited: number
    total_balance: number
    return_count: number
    certificate_count: number
    exceptions: number
    exception_exposure: number
    reconciliation_status: string
  }
  datasets: Dataset[]
}

/** Turn an ExportDataset (columns + rows) into a downloaded .xlsx. */
function downloadDataset(ds: Dataset, fy: string) {
  if (!ds.rows.length) {
    toast.error(`${ds.label} has no rows for FY ${fy}`)
    return
  }
  exportRowsToExcel(
    `TDS ${ds.label} ${fy}`,
    ds.rows,
    ds.columns.map((c) => ({ header: c.header, value: (row) => row[c.key] })),
  )
  toast.success(`Exported ${ds.rows.length} row${ds.rows.length === 1 ? "" : "s"}`)
}

function DatasetRow({ meta, fy, direction }: { meta: { key: string; label: string }; fy: string; direction: Direction }) {
  const [loading, setLoading] = useState(false)

  async function handleDownload() {
    setLoading(true)
    try {
      const res = await fetch(`/api/finance/tds/export?fy=${fy}&direction=${direction}&kind=${meta.key}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Export failed")
      const ds = (await res.json()) as Dataset
      downloadDataset(ds, fy)
    } catch (e) {
      toast.error((e as Error).message || "Could not export")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{meta.label}</span>
      </div>
      <Button size="sm" variant="outline" disabled={loading} onClick={handleDownload}>
        <Download data-icon="inline-start" />
        {loading ? "Preparing…" : "Excel"}
      </Button>
    </div>
  )
}

export function ExportStage({ direction, fy }: { direction: Direction; fy: string }) {
  const { data: catalog } = useSWR<Catalog>(`/api/finance/tds/export?fy=${fy}&direction=${direction}`, fetcher)
  const { data: ca, isLoading: caLoading } = useSWR<CaPackage>(
    `/api/finance/tds/export?fy=${fy}&direction=${direction}&ca=1`,
    fetcher,
  )
  const [downloadingAll, setDownloadingAll] = useState(false)
  const copy = DIRECTION_COPY[direction]

  const datasets = catalog?.datasets ?? []

  async function downloadCaPackage() {
    if (!ca) return
    setDownloadingAll(true)
    try {
      let exported = 0
      for (const ds of ca.datasets) {
        if (!ds.rows.length) continue
        exportRowsToExcel(
          `TDS ${ds.label} ${fy}`,
          ds.rows,
          ds.columns.map((c) => ({ header: c.header, value: (row) => row[c.key] })),
        )
        exported += 1
      }
      toast.success(`CA package: ${exported} register${exported === 1 ? "" : "s"} downloaded`)
    } finally {
      setDownloadingAll(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <StageHeading icon={<Package className="h-5 w-5 text-muted-foreground" />} title="Export & CA Review" />

      <p className="text-sm text-muted-foreground">
        Download every statutory register for <strong>{copy.label}</strong>, FY {fy}, as Excel — or hand your CA the
        one-click review package below. Every dataset is generated live from the same engines that drive the filing, so
        exports always match what is on screen.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            CA Review Package · FY {fy}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {caLoading ? (
            <p className="text-sm text-muted-foreground">Assembling package…</p>
          ) : ca ? (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat label="Total TDS" value={currency(ca.summary.total_tds)} />
                <Stat label="Deposited" value={currency(ca.summary.total_deposited)} />
                <Stat label="Balance" value={currency(ca.summary.total_balance)} />
                <Stat
                  label="Exceptions"
                  value={String(ca.summary.exceptions)}
                  hint={ca.summary.exception_exposure ? currency(ca.summary.exception_exposure) : undefined}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground">
                <span>
                  Deductor: <strong className="text-foreground">{ca.deductor.name || "—"}</strong>
                </span>
                <span>
                  TAN: <span className="font-mono">{ca.deductor.tan || "—"}</span>
                </span>
                <span>
                  Returns: <strong className="text-foreground">{ca.summary.return_count}</strong>
                </span>
                <span>
                  Certificates: <strong className="text-foreground">{ca.summary.certificate_count}</strong>
                </span>
                <span className="flex items-center gap-1.5">
                  Reconciliation:{" "}
                  <Badge variant={ca.summary.reconciliation_status === "Balanced" ? "default" : "destructive"}>
                    {ca.summary.reconciliation_status}
                  </Badge>
                </span>
              </div>
              <div>
                <Button onClick={downloadCaPackage} disabled={downloadingAll || !ca.datasets.length}>
                  <Download data-icon="inline-start" />
                  {downloadingAll ? "Downloading…" : `Download all ${ca.datasets.length} registers`}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Package unavailable for this selection.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" />
            Individual registers
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {datasets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Loading available exports…</p>
          ) : (
            datasets.map((ds) => <DatasetRow key={ds.key} meta={ds} fy={fy} direction={direction} />)
          )}
        </CardContent>
      </Card>
    </div>
  )
}
