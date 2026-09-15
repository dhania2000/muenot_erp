"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2Icon, Mail, CheckCircle2, AlertTriangle } from "lucide-react"

/**
 * Email a Financial Report. Posts the report key + active period/filters to
 * /api/finance/reports/email, which regenerates the rows server-side and sends
 * a formatted table through the finance email hub.
 */
export function ReportEmailDialog({
  open,
  onClose,
  reportKey,
  reportLabel,
  from,
  to,
  filters,
  subtitle,
}: {
  open: boolean
  onClose: () => void
  reportKey: string
  reportLabel: string
  from: string
  to: string
  filters: Record<string, string>
  subtitle: string
}) {
  const [toEmail, setToEmail] = useState("")
  const [cc, setCc] = useState("")
  const [message, setMessage] = useState("")
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle")
  const [error, setError] = useState("")

  async function send() {
    if (!toEmail.trim()) {
      setError("Enter a recipient email address.")
      setStatus("error")
      return
    }
    setStatus("sending")
    setError("")
    try {
      const res = await fetch("/api/finance/reports/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report: reportKey,
          to_email: toEmail.trim(),
          cc: cc.trim() || null,
          message: message.trim(),
          subtitle,
          from,
          to,
          filters,
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
    } catch {
      setError("Network error while sending the report.")
      setStatus("error")
    }
  }

  function handleClose() {
    setStatus("idle")
    setError("")
    setToEmail("")
    setCc("")
    setMessage("")
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-4" /> Email report
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
          <div className="space-y-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-to">
                Recipient
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
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-email-msg">
                Message <span className="font-normal">(optional)</span>
              </label>
              <Textarea
                id="report-email-msg"
                rows={3}
                placeholder="Add a short note that appears above the report."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            {status === "error" && error ? (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="size-4" /> {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The report is regenerated with the latest posted figures before sending.
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
