"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2Icon, Mail, CheckCircle2, AlertTriangle, FileText } from "lucide-react"
import { buildReportPdfBlob, reportPdfFileName } from "@/lib/report-pdf"
import type { ReportColumn, ReportCompany, ReportExportPayload } from "@/lib/report-tally"

/**
 * Email a Financial Report (Phases 16–18).
 *
 * The flow captures recipient email + name, an auto-generated but editable
 * subject and message (Phase 17), and an "Attach PDF" option (Phase 16) that
 * builds the EXACT report snapshot as a PDF client-side, uploads it to the
 * shared email-attachments store, and hands the pathname to the finance email
 * hub. The server regenerates the table body from the latest posted figures
 * and records the send in the report Email history.
 */
export function ReportEmailDialog({
  open,
  onClose,
  reportKey,
  reportLabel,
  reportDescription,
  from,
  to,
  filters,
  subtitle,
  periodLabel,
  filterLabels,
  columns,
  rows,
  company,
  generatedAt,
  generatedBy,
}: {
  open: boolean
  onClose: () => void
  reportKey: string
  reportLabel: string
  reportDescription?: string
  from: string
  to: string
  filters: Record<string, string>
  subtitle: string
  periodLabel: string
  filterLabels: string[]
  columns: ReportColumn[]
  rows: Record<string, any>[]
  company: ReportCompany | null
  generatedAt: string
  generatedBy: string
}) {
  const [toEmail, setToEmail] = useState("")
  const [toName, setToName] = useState("")
  const [cc, setCc] = useState("")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [attachPdf, setAttachPdf] = useState(true)
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle")
  const [error, setError] = useState("")

  const companyName = company?.name || "Company"

  // Phase 17 — default subject/message templates. Regenerated whenever the
  // dialog opens or the report/period changes, but fully editable afterwards.
  const defaultSubject = [reportLabel, companyName, periodLabel].filter(Boolean).join(" - ")

  useEffect(() => {
    if (!open) return
    setSubject((prev) => prev || defaultSubject)
    setMessage(
      (prev) =>
        prev ||
        `Dear ${toName || "Sir/Madam"},\n\n` +
          `Please find the ${reportLabel}${periodLabel ? ` for ${periodLabel}` : ""} ` +
          `generated from ${companyName}${attachPdf ? ", attached as a PDF" : ""}.\n\n` +
          `Regards,\n${generatedBy || companyName}`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reportKey, periodLabel])

  function exportPayload(): ReportExportPayload {
    return {
      reportKey,
      reportLabel,
      reportDescription,
      columns,
      rows,
      company,
      subtitle,
      filterLabels,
      generatedAt,
      generatedBy,
    }
  }

  async function uploadPdfSnapshot(): Promise<{
    pathname: string
    filename: string
    contentType: string
    size: number
  } | null> {
    const blob = await buildReportPdfBlob(exportPayload())
    const filename = reportPdfFileName(exportPayload())
    const file = new File([blob], filename, { type: "application/pdf" })
    const form = new FormData()
    form.append("file", file)
    const res = await fetch("/api/email-attachments", { method: "POST", body: form })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.pathname) {
      throw new Error(json.error || "Could not attach the report PDF.")
    }
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
      let attachment = null
      if (attachPdf && rows.length > 0) {
        attachment = await uploadPdfSnapshot()
      }

      const res = await fetch("/api/finance/reports/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report: reportKey,
          to_email: toEmail.trim(),
          to_name: toName.trim() || null,
          cc: cc.trim() || null,
          subject: subject.trim(),
          message: message.trim(),
          subtitle,
          period_label: periodLabel,
          filters_text: filterLabels.join(", "),
          from,
          to,
          filters,
          attachment,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setError(json.error || "Could not send the report.")
        setStatus("error")
        return
      }
      setStatus("sent")
      setTimeout(() => {
        handleClose()
      }, 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error while sending the report.")
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
    setAttachPdf(true)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-4" /> Send report email
          </DialogTitle>
          <DialogDescription>
            {reportLabel}
            {subtitle ? ` — ${subtitle}` : ""}
          </DialogDescription>
        </DialogHeader>

        {status === "sent" ? (
          <div className="flex items-center gap-2 py-6 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-5" /> Report sent to {toEmail}.
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-to">
                  Recipient email
                </label>
                <Input
                  id="report-email-to"
                  type="email"
                  placeholder="name@company.com"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-name">
                  Recipient name
                </label>
                <Input
                  id="report-email-name"
                  placeholder="e.g. Priya Sharma"
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-cc">
                CC <span className="font-normal">(optional)</span>
              </label>
              <Input
                id="report-email-cc"
                placeholder="cc@company.com"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-subject">
                Subject
              </label>
              <Input
                id="report-email-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={defaultSubject}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-msg">
                Message
              </label>
              <Textarea
                id="report-email-msg"
                rows={5}
                placeholder="Add a short note that appears above the report."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <label className="flex items-start gap-2.5 rounded-md border p-3">
              <Checkbox
                checked={attachPdf}
                onCheckedChange={(v) => setAttachPdf(v === true)}
                disabled={rows.length === 0}
                aria-label="Attach the report as a PDF"
              />
              <span className="space-y-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <FileText className="size-3.5" /> Attach PDF
                </span>
                <span className="block text-xs text-muted-foreground">
                  {rows.length === 0
                    ? "No rows to attach for the selected period."
                    : "Attaches the exact report snapshot (period, filters, generated stamp) as a PDF."}
                </span>
              </span>
            </label>

            {status === "error" && error ? (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="size-4" /> {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The report table is regenerated with the latest posted figures before sending.
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
                  <Mail data-icon="inline-start" /> Send report
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
