"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FolderCheck,
  Loader2Icon,
  Mail,
  RotateCcw,
} from "lucide-react"
import {
  buildCaPackagePdfBlob,
  caPackageFileName,
  CA_PACKAGE_DEFAULT_KEYS,
  exportCaPackagePdf,
  type CaPackagePayload,
} from "@/lib/report-ca-package"
import {
  defaultPeriod,
  fyLabel,
  fyOptions,
  monthOptions,
  periodLabel as buildPeriodLabel,
  QUARTER_OPTIONS,
  resolveRange,
  type PeriodPreset,
  type PeriodState,
} from "@/lib/report-period"

type CatalogueEntry = {
  key: string
  label: string
  group: string
  description: string
}

type ReportCapabilities = { canExport: boolean; canEmail: boolean }

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

// The package always resolves to a real date range so as-on statements (Trial
// Balance, Balance Sheet) close on the period end and range statements (P&L,
// Cash Flow) span it — matching how a CA reads a year-end set.
function PackagePeriodControls({
  period,
  setPeriod,
}: {
  period: PeriodState
  setPeriod: (updater: (p: PeriodState) => PeriodState) => void
}) {
  const fys = useMemo(() => fyOptions(), [])
  const months = useMemo(() => monthOptions(), [])
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-preset">
          Period
        </label>
        <select
          id="pkg-preset"
          className={selectClass}
          value={period.preset}
          onChange={(e) => setPeriod((p) => ({ ...p, preset: e.target.value as PeriodPreset }))}
        >
          <option value="fy">Financial Year</option>
          <option value="quarter">Quarter</option>
          <option value="month">Month</option>
          <option value="custom">Custom range</option>
          <option value="all">All time</option>
        </select>
      </div>

      {(period.preset === "fy" || period.preset === "quarter") && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-fy">
            Financial year
          </label>
          <select
            id="pkg-fy"
            className={selectClass}
            value={period.fy}
            onChange={(e) => setPeriod((p) => ({ ...p, fy: e.target.value }))}
          >
            {fys.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {period.preset === "quarter" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-quarter">
            Quarter
          </label>
          <select
            id="pkg-quarter"
            className={selectClass}
            value={period.quarter}
            onChange={(e) => setPeriod((p) => ({ ...p, quarter: e.target.value }))}
          >
            {QUARTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {period.preset === "month" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-month">
            Month
          </label>
          <select
            id="pkg-month"
            className={selectClass}
            value={period.month}
            onChange={(e) => setPeriod((p) => ({ ...p, month: e.target.value }))}
          >
            {months.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {period.preset === "custom" && (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-from">
              From date
            </label>
            <Input
              id="pkg-from"
              type="date"
              value={period.from}
              onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-to">
              To date
            </label>
            <Input
              id="pkg-to"
              type="date"
              value={period.to}
              onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
            />
          </div>
        </>
      )}
    </div>
  )
}

export function CaPackagePanel({
  catalogue,
  capabilities,
}: {
  catalogue: CatalogueEntry[]
  capabilities: ReportCapabilities
}) {
  const [period, setPeriod] = useState<PeriodState>(defaultPeriod)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [seeded, setSeeded] = useState(false)
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle")
  const [error, setError] = useState("")
  const [emailOpen, setEmailOpen] = useState(false)

  // Available keys in the accessible catalogue, and the CA defaults that exist.
  const availableKeys = useMemo(() => new Set(catalogue.map((r) => r.key)), [catalogue])
  const defaultKeys = useMemo(
    () => CA_PACKAGE_DEFAULT_KEYS.filter((k) => availableKeys.has(k)),
    [availableKeys],
  )

  // Seed the selection with the CA defaults once the catalogue has loaded.
  useEffect(() => {
    if (seeded || catalogue.length === 0) return
    setSelected(new Set(defaultKeys))
    setSeeded(true)
  }, [seeded, catalogue.length, defaultKeys])

  const groups = useMemo(() => {
    const map = new Map<string, CatalogueEntry[]>()
    for (const r of catalogue) {
      const list = map.get(r.group) ?? []
      list.push(r)
      map.set(r.group, list)
    }
    return Array.from(map, ([group, reports]) => ({ group, reports }))
  }, [catalogue])

  // Selected reports kept in catalogue order so the package/index read top-down.
  const selectedEntries = useMemo(
    () => catalogue.filter((r) => selected.has(r.key)),
    [catalogue, selected],
  )

  const { from, to } = resolveRange("range", period)
  const periodLabel = buildPeriodLabel("range", period)
  const financialYear = ["fy", "quarter", "month"].includes(period.preset)
    ? fyLabel(Number(period.fy))
    : ""

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleGroup(reports: CatalogueEntry[], allSelected: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const r of reports) {
        if (allSelected) next.delete(r.key)
        else next.add(r.key)
      }
      return next
    })
  }

  function resetToDefaults() {
    setSelected(new Set(defaultKeys))
    setStatus("idle")
    setError("")
  }

  async function fetchPackage(): Promise<CaPackagePayload> {
    const res = await fetch("/api/finance/reports/package", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: selectedEntries.map((r) => r.key), from, to, filters: {} }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || "Could not generate the package.")
    return {
      company: json.company ?? null,
      title: "CA Report Package",
      periodLabel,
      financialYear,
      generatedAt: json.generatedAt || new Date().toISOString(),
      generatedBy: json.generatedBy || "",
      reports: (json.reports ?? []).map((r: any) => ({
        key: r.key,
        label: r.label,
        group: r.group,
        description: r.description,
        columns: r.columns ?? [],
        rows: r.rows ?? [],
      })),
    }
  }

  function logRun(rowCount: number) {
    fetch("/api/finance/reports/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report_key: "ca-package",
        report_label: "CA Report Package",
        format: "PDF",
        period_label: periodLabel,
        filters_text: `${selectedEntries.length} reports`,
        row_count: rowCount,
      }),
    }).catch(() => {})
  }

  async function generatePdf() {
    if (selectedEntries.length === 0) {
      setError("Select at least one report for the package.")
      setStatus("error")
      return
    }
    setStatus("generating")
    setError("")
    try {
      const payload = await fetchPackage()
      await exportCaPackagePdf(payload)
      logRun(payload.reports.reduce((s, r) => s + r.rows.length, 0))
      setStatus("done")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the package.")
      setStatus("error")
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderCheck className="size-4 text-primary" /> CA Report Package
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Generate the full statutory set as a single, bound PDF — cover page, company details,
            report index and every selected report with page numbers — ready to hand to your
            chartered accountant or email as one attachment.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Period</p>
            <PackagePeriodControls period={period} setPeriod={setPeriod} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">Reports in this package</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {selectedEntries.length} report{selectedEntries.length === 1 ? "" : "s"} selected
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={resetToDefaults}>
            <RotateCcw data-icon="inline-start" />
            CA defaults
          </Button>
        </CardHeader>
        <CardContent>
          <div className="max-h-[420px] space-y-4 overflow-y-auto pr-1">
            {groups.map(({ group, reports }) => {
              const allSelected = reports.every((r) => selected.has(r.key))
              const someSelected = reports.some((r) => selected.has(r.key))
              return (
                <div key={group} className="space-y-2">
                  <div className="flex items-center gap-2 border-b pb-1.5">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={() => toggleGroup(reports, allSelected)}
                      aria-label={`Toggle all ${group} reports`}
                    />
                    <span className="text-sm font-semibold">{group}</span>
                    <Badge variant="secondary" className="ml-auto">
                      {reports.filter((r) => selected.has(r.key)).length}/{reports.length}
                    </Badge>
                  </div>
                  <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {reports.map((r) => (
                      <label
                        key={r.key}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={selected.has(r.key)}
                          onCheckedChange={() => toggle(r.key)}
                          aria-label={`Include ${r.label}`}
                          className="mt-0.5"
                        />
                        <span className="text-sm">{r.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {status === "error" && error ? (
              <span className="flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="size-4" /> {error}
              </span>
            ) : status === "done" ? (
              <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" /> Package generated.
              </span>
            ) : (
              <span>
                {periodLabel}
                {financialYear ? `  •  ${financialYear}` : ""}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {capabilities.canEmail && (
              <Button
                variant="outline"
                onClick={() => setEmailOpen(true)}
                disabled={selectedEntries.length === 0 || status === "generating"}
              >
                <Mail data-icon="inline-start" />
                Email package
              </Button>
            )}
            <Button
              onClick={generatePdf}
              disabled={selectedEntries.length === 0 || status === "generating" || !capabilities.canExport}
            >
              {status === "generating" ? (
                <>
                  <Loader2Icon data-icon="inline-start" className="animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <FileText data-icon="inline-start" /> Download PDF package
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {!capabilities.canExport && (
        <p className="text-sm text-muted-foreground">
          You do not have permission to export reports, so the CA package cannot be generated.
        </p>
      )}

      <CaPackageEmailDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        keys={selectedEntries.map((r) => r.key)}
        reportCount={selectedEntries.length}
        from={from}
        to={to}
        periodLabel={periodLabel}
        buildPayload={fetchPackage}
      />
    </div>
  )
}

function CaPackageEmailDialog({
  open,
  onClose,
  keys,
  reportCount,
  from,
  to,
  periodLabel,
  buildPayload,
}: {
  open: boolean
  onClose: () => void
  keys: string[]
  reportCount: number
  from: string
  to: string
  periodLabel: string
  buildPayload: () => Promise<CaPackagePayload>
}) {
  const [toEmail, setToEmail] = useState("")
  const [toName, setToName] = useState("")
  const [cc, setCc] = useState("")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle")
  const [error, setError] = useState("")

  const defaultSubject = ["CA Report Package", periodLabel].filter(Boolean).join(" - ")

  useEffect(() => {
    if (!open) return
    setSubject((prev) => prev || defaultSubject)
    setMessage(
      (prev) =>
        prev ||
        `Dear ${toName || "Sir/Madam"},\n\n` +
          `Please find the CA Report Package${periodLabel ? ` for ${periodLabel}` : ""} ` +
          `attached as a single PDF, containing ${reportCount} report${reportCount === 1 ? "" : "s"}.\n\n` +
          `Regards`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, periodLabel, reportCount])

  async function uploadPdf(): Promise<{
    pathname: string
    filename: string
    contentType: string
    size: number
  }> {
    const payload = await buildPayload()
    const blob = await buildCaPackagePdfBlob(payload)
    const filename = caPackageFileName(payload)
    const file = new File([blob], filename, { type: "application/pdf" })
    const form = new FormData()
    form.append("file", file)
    const res = await fetch("/api/email-attachments", { method: "POST", body: form })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.pathname) throw new Error(json.error || "Could not attach the package PDF.")
    return {
      pathname: json.pathname,
      filename: json.filename || filename,
      contentType: json.contentType || "application/pdf",
      size: json.size || file.size,
    }
  }

  async function send() {
    if (!toEmail.trim()) {
      setError("Enter a recipient email address.")
      setStatus("error")
      return
    }
    setStatus("sending")
    setError("")
    try {
      const attachment = await uploadPdf()
      const res = await fetch("/api/finance/reports/package/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keys,
          to_email: toEmail.trim(),
          to_name: toName.trim() || null,
          cc: cc.trim() || null,
          subject: subject.trim(),
          message: message.trim(),
          period_label: periodLabel,
          from,
          to,
          filters: {},
          attachment,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setError(json.error || "Could not send the package.")
        setStatus("error")
        return
      }
      setStatus("sent")
      setTimeout(handleClose, 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error while sending the package.")
      setStatus("error")
    }
  }

  function handleClose() {
    setStatus("idle")
    setError("")
    setToEmail("")
    setToName("")
    setCc("")
    setSubject("")
    setMessage("")
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-4" /> Email CA package
          </DialogTitle>
          <DialogDescription>
            {reportCount} report{reportCount === 1 ? "" : "s"}
            {periodLabel ? ` — ${periodLabel}` : ""}, attached as a single PDF.
          </DialogDescription>
        </DialogHeader>

        {status === "sent" ? (
          <div className="flex items-center gap-2 py-6 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-5" /> Package sent to {toEmail}.
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-email-to">
                  Recipient email
                </label>
                <Input
                  id="pkg-email-to"
                  type="email"
                  placeholder="ca@firm.com"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-email-name">
                  Recipient name
                </label>
                <Input
                  id="pkg-email-name"
                  placeholder="e.g. Priya Sharma"
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-email-cc">
                CC <span className="font-normal">(optional)</span>
              </label>
              <Input
                id="pkg-email-cc"
                placeholder="cc@company.com"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-email-subject">
                Subject
              </label>
              <Input
                id="pkg-email-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={defaultSubject}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="pkg-email-msg">
                Message
              </label>
              <Textarea
                id="pkg-email-msg"
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a short note that appears above the report index."
              />
            </div>

            {status === "error" && error ? (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="size-4" /> {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The combined PDF is built and attached, and an authoritative report index is
                regenerated server-side before sending.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={status === "sending"}>
            {status === "sent" ? "Close" : "Cancel"}
          </Button>
          {status !== "sent" && (
            <Button onClick={send} disabled={status === "sending"}>
              {status === "sending" ? (
                <>
                  <Loader2Icon data-icon="inline-start" className="animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Mail data-icon="inline-start" /> Send package
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
