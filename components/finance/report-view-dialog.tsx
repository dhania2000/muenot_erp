"use client"

import { useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { inr0 } from "@/lib/finance-calc"
import { Download, FileSpreadsheet, FileText, Mail, Printer, X } from "lucide-react"

type ReportColumn = { key: string; label: string; align?: "left" | "right"; money?: boolean; date?: boolean }

export type ReportCompany = {
  name: string
  addressLines: string[]
  email: string
  phone: string
  website: string
  taxLabel: string
  taxNumber: string
  pan?: string
}

const currency = (n: number) => inr0(Number(n) || 0)

// Flat, transaction-level reports can return tens of thousands of rows. The
// preview sheet caps how many are painted into the DOM so opening a large
// report never crashes the browser tab; totals stay computed from the full set,
// and the CSV / Excel / PDF exports always contain every row. Grouped reports
// are account-level aggregates and stay small, so they are never capped.
const VIEW_ROW_CAP = 1000

/** Render an ISO/date-ish value as dd-mm-yyyy; leave non-dates untouched. */
function fmtCellDate(value: any): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`
}

function cellText(value: any, col: ReportColumn) {
  if (value === null || value === undefined || value === "") return "—"
  if (col.money) return currency(value)
  if (col.date) return fmtCellDate(value)
  return String(value)
}

// The dimension a report is naturally grouped by, if any. Reports that expose an
// account group / group column render as a hierarchy with per-group subtotals;
// everything else renders flat. Kept purely presentational — the row data is
// untouched.
function groupColumnKey(columns: ReportColumn[]): string | null {
  const candidate = columns.find((c) => c.key === "account_group" || c.key === "group")
  // Only group when it isn't the sole descriptive column (avoids a pointless
  // single-column hierarchy).
  if (candidate && columns.length > 2) return candidate.key
  return null
}

// The column used as the clickable drill dimension (account name), if present.
function accountColumnKey(columns: ReportColumn[]): string | null {
  const c = columns.find((col) => col.key === "account" || col.key === "account_name")
  return c ? c.key : null
}

export function ReportViewDialog({
  open,
  onClose,
  reportLabel,
  reportDescription,
  columns,
  rows,
  company,
  subtitle,
  generatedAt,
  filterLabels,
  onDownloadCsv,
  onDownloadExcel,
  onDownloadPdf,
  onEmail,
  onDrill,
}: {
  open: boolean
  onClose: () => void
  reportLabel: string
  reportDescription: string
  columns: ReportColumn[]
  rows: Record<string, any>[]
  company: ReportCompany | null
  subtitle: string
  generatedAt: string
  filterLabels: string[]
  onDownloadCsv: () => void
  onDownloadExcel: () => void
  onDownloadPdf: () => void
  onEmail: () => void
  onDrill: (target: { account?: string; group?: string; label: string }) => void
}) {
  const moneyCols = useMemo(() => columns.filter((c) => c.money), [columns])
  const grandTotals = useMemo(() => {
    if (!moneyCols.length || !rows.length) return null
    const t: Record<string, number> = {}
    for (const c of moneyCols) t[c.key] = rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
    return t
  }, [moneyCols, rows])

  const groupKey = useMemo(() => groupColumnKey(columns), [columns])
  const accountKey = useMemo(() => accountColumnKey(columns), [columns])

  // Build the ordered group → rows structure when grouping applies.
  const grouped = useMemo(() => {
    if (!groupKey) return null
    const order: string[] = []
    const map = new Map<string, Record<string, any>[]>()
    for (const r of rows) {
      const g = String(r[groupKey] ?? "—") || "—"
      if (!map.has(g)) {
        map.set(g, [])
        order.push(g)
      }
      map.get(g)!.push(r)
    }
    return order.map((g) => {
      const groupRows = map.get(g)!
      const subtotals: Record<string, number> = {}
      for (const c of moneyCols) subtotals[c.key] = groupRows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
      return { group: g, rows: groupRows, subtotals }
    })
  }, [groupKey, rows, moneyCols])

  const generatedLabel = useMemo(() => {
    if (!generatedAt) return ""
    try {
      const d = new Date(generatedAt)
      const p = (n: number) => String(n).padStart(2, "0")
      return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch {
      return ""
    }
  }, [generatedAt])

  function drillRow(row: Record<string, any>) {
    if (accountKey && row[accountKey]) {
      onDrill({ account: String(row[accountKey]), label: String(row[accountKey]) })
      return
    }
    if (groupKey && row[groupKey]) {
      onDrill({ group: String(row[groupKey]), label: String(row[groupKey]) })
    }
  }

  const canDrillRow = Boolean(accountKey)
  const colCount = columns.length

  const thClass = (c: ReportColumn) =>
    `sticky top-0 z-10 border-b-2 border-foreground/70 bg-background px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${
      c.align === "right" || c.money ? "text-right" : "text-left"
    }`
  const tdClass = (c: ReportColumn) =>
    `px-3 py-1.5 ${c.align === "right" || c.money ? "text-right tabular-nums" : "text-left"}`

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        data-report-print="container"
        showCloseButton={false}
        className="flex h-[92vh] max-h-[92vh] w-[96vw] max-w-[1100px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1100px]"
      >
        {/* Toolbar (never printed) */}
        <div className="no-print flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
          <DialogTitle className="text-sm font-medium">{reportLabel}</DialogTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onDownloadCsv} disabled={rows.length === 0}>
              <Download data-icon="inline-start" /> CSV
            </Button>
            <Button variant="outline" size="sm" onClick={onDownloadExcel} disabled={rows.length === 0}>
              <FileSpreadsheet data-icon="inline-start" /> Excel
            </Button>
            <Button variant="outline" size="sm" onClick={onDownloadPdf} disabled={rows.length === 0}>
              <FileText data-icon="inline-start" /> PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={rows.length === 0}
            >
              <Printer data-icon="inline-start" /> Print
            </Button>
            <Button variant="outline" size="sm" onClick={onEmail} disabled={rows.length === 0}>
              <Mail data-icon="inline-start" /> Email
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </div>
        </div>

        {/* Scrollable report sheet */}
        <div data-report-print="scroll" className="flex-1 overflow-auto bg-muted/20 p-4 sm:p-6">
          <div
            data-report-print="sheet"
            className="mx-auto max-w-[960px] rounded-md border bg-background p-6 shadow-sm sm:p-8"
          >
            {/* Letterhead */}
            <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-foreground/70 pb-4">
              <div>
                <p className="text-lg font-semibold tracking-tight">{company?.name || "Company"}</p>
                {company?.addressLines.map((l, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {l}
                  </p>
                ))}
                <p className="mt-1 text-xs text-muted-foreground">
                  {[
                    company?.taxNumber && `${company.taxLabel}: ${company.taxNumber}`,
                    company?.pan && `PAN: ${company.pan}`,
                    company?.email,
                    company?.phone,
                  ]
                    .filter(Boolean)
                    .join("  •  ")}
                </p>
              </div>
            </div>

            {/* Report title block */}
            <div className="py-4 text-center">
              <h2 className="text-base font-semibold">{reportLabel}</h2>
              {reportDescription && (
                <p className="mt-0.5 text-xs text-muted-foreground">{reportDescription}</p>
              )}
              {subtitle && <p className="mt-1 text-xs font-medium text-foreground">{subtitle}</p>}
              <p className="mt-1 text-[11px] text-muted-foreground">
                {generatedLabel ? `Generated ${generatedLabel}` : ""}
                {generatedLabel ? "  •  " : ""}
                {rows.length} row{rows.length === 1 ? "" : "s"}
              </p>
              {filterLabels.length > 0 && (
                <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                  {filterLabels.map((f) => (
                    <Badge key={f} variant="secondary" className="text-[11px]">
                      {f}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.key} className={thClass(c)}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>

                {rows.length === 0 ? (
                  <tbody>
                    <tr>
                      <td colSpan={colCount} className="px-3 py-8 text-center text-muted-foreground">
                        No records for the selected period.
                      </td>
                    </tr>
                  </tbody>
                ) : grouped ? (
                  grouped.map((section) => (
                    <tbody key={section.group} className="border-b">
                      <tr className="bg-muted/50">
                        <td
                          colSpan={colCount}
                          className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-foreground"
                        >
                          {section.group}
                        </td>
                      </tr>
                      {section.rows.map((row, i) => (
                        <tr
                          key={i}
                          className={`border-t border-border/60 ${
                            canDrillRow ? "cursor-pointer hover:bg-primary/5" : ""
                          }`}
                          onClick={canDrillRow ? () => drillRow(row) : undefined}
                        >
                          {columns.map((c) => (
                            <td
                              key={c.key}
                              className={`${tdClass(c)} ${
                                canDrillRow && c.key === accountKey ? "font-medium text-primary" : ""
                              }`}
                            >
                              {c.key === groupKey ? "" : cellText(row[c.key], c)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {moneyCols.length > 0 && (
                        <tr className="border-t bg-muted/30 font-medium">
                          {columns.map((c, i) => (
                            <td key={c.key} className={tdClass(c)}>
                              {i === 0
                                ? `Subtotal — ${section.group}`
                                : section.subtotals[c.key] !== undefined
                                  ? currency(section.subtotals[c.key])
                                  : ""}
                            </td>
                          ))}
                        </tr>
                      )}
                    </tbody>
                  ))
                ) : (
                  <tbody>
                    {rows.slice(0, VIEW_ROW_CAP).map((row, i) => (
                      <tr
                        key={i}
                        className={`border-t border-border/60 ${
                          canDrillRow ? "cursor-pointer hover:bg-primary/5" : ""
                        }`}
                        onClick={canDrillRow ? () => drillRow(row) : undefined}
                      >
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className={`${tdClass(c)} ${
                              canDrillRow && c.key === accountKey ? "font-medium text-primary" : ""
                            }`}
                          >
                            {cellText(row[c.key], c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {rows.length > VIEW_ROW_CAP && (
                      <tr>
                        <td
                          colSpan={colCount}
                          className="px-3 py-3 text-center text-xs text-muted-foreground"
                        >
                          Showing the first {VIEW_ROW_CAP.toLocaleString("en-IN")} of{" "}
                          {rows.length.toLocaleString("en-IN")} rows. The total below covers every
                          row — download the report (CSV / Excel / PDF) for the complete listing.
                        </td>
                      </tr>
                    )}
                  </tbody>
                )}

                {grandTotals && rows.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-foreground/70 bg-muted/60 font-semibold">
                      {columns.map((c, i) => (
                        <td key={c.key} className={tdClass(c)}>
                          {i === 0
                            ? "Total"
                            : grandTotals[c.key] !== undefined
                              ? currency(grandTotals[c.key])
                              : ""}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {canDrillRow && rows.length > 0 && (
              <p className="no-print mt-3 text-[11px] text-muted-foreground">
                Tip: click any account row to drill into its ledger and trace the source documents.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
