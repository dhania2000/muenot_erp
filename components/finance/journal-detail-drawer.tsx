"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { inr } from "@/lib/finance-calc"
import { Paperclip, ExternalLink, Clock, ArrowRight, FileText, BookOpen, Layers, BarChart3, AlertTriangle } from "lucide-react"

type Row = Record<string, any>

type JournalTrace = {
  voucherNo: string
  source: {
    isManual: boolean
    sourceModule: string
    reference: string
    href: string | null
    missing: boolean
  }
  journal: { present: boolean; totalDebit: number; totalCredit: number; balanced: boolean; lines: any[] }
  ledger: { present: boolean; totalDebit: number; totalCredit: number; matchesJournal: boolean; lines: any[] }
  reports: { accountGroup: string; statement: string; href: string; amount: number }[]
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

const STATUS_BADGE: Record<string, BadgeVariant> = {
  Draft: "outline",
  "Pending Approval": "secondary",
  Approved: "default",
  Posted: "default",
  Rejected: "destructive",
  Cancelled: "destructive",
  Reversed: "secondary",
}

type AuditEvent = {
  id: number
  event_type: string
  summary: string
  amount: number | null
  actor_name: string | null
  created_at: string | null
}

export type JournalDetail = {
  voucherNo: string
  journalDate: string
  voucherType: string
  narration: string
  referenceNo: string
  sourceModule: string
  financialYear: string
  isManual: boolean
  status: string
  postingStatus: string
  reversalOf: string
  reversedBy: string
  totalDebit: number
  totalCredit: number
  lines: Row[]
}

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtDateTime(iso: string | null) {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  )
}

export function JournalDetailDrawer({
  detail,
  open,
  onOpenChange,
}: {
  detail: JournalDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // The audit trail is stored per manual-journal voucher; fetch it only for
  // manual journals (system postings keep their trail on the source document).
  const { data } = useSWR<{ events: AuditEvent[] }>(
    open && detail && detail.isManual
      ? `/api/finance/journal-entries/manual?journal_id=${encodeURIComponent(detail.voucherNo)}`
      : null,
    fetcher,
  )
  const events = data?.events ?? []

  // Phase 53 — full drill chain (Source → Journal → GL → Report) for this
  // voucher, fetched read-only whenever the drawer is open.
  const { data: traceData } = useSWR<{ trace: JournalTrace }>(
    open && detail ? `/api/finance/journal-entries/trace?voucher=${encodeURIComponent(detail.voucherNo)}` : null,
    fetcher,
  )
  const trace = traceData?.trace ?? null

  const head = detail?.lines?.[0] ?? {}
  const paymentMode = String(head.payment_mode ?? "")
  const chequeRef = String(head.cheque_utr_reference ?? "")
  const attachmentUrl = String(head.attachment_url ?? "")
  const attachmentType = String(head.attachment_type ?? "")
  const sourceReference = String(head.source_reference ?? "")
  const approvedBy = String(head.approved_by ?? "")
  const postingDate = String(head.posting_date ?? "").slice(0, 10)

  const gstTotal = detail ? detail.lines.reduce((s, l) => s + num(l.gst_amount), 0) : 0
  const tdsTotal = detail ? detail.lines.reduce((s, l) => s + num(l.tds_amount), 0) : 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl">
        {detail && (
          <>
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="font-mono text-sm">{detail.voucherNo}</SheetTitle>
                {detail.status ? (
                  <Badge variant={STATUS_BADGE[detail.status] ?? "outline"}>{detail.status}</Badge>
                ) : null}
                <Badge variant={detail.postingStatus === "Posted" ? "default" : "outline"}>
                  {detail.postingStatus || "Unposted"}
                </Badge>
                <Badge variant={detail.isManual ? "outline" : "secondary"}>{detail.sourceModule}</Badge>
              </div>
              {detail.narration ? <p className="text-sm text-muted-foreground">{detail.narration}</p> : null}
            </SheetHeader>

            {(detail.reversalOf || detail.reversedBy) && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                {detail.reversalOf ? (
                  <span>
                    Reversal of <span className="font-mono">{detail.reversalOf}</span>
                  </span>
                ) : (
                  <span>
                    Reversed by <span className="font-mono">{detail.reversedBy}</span>
                  </span>
                )}
              </div>
            )}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Journal date">{detail.journalDate || "—"}</Field>
              <Field label="Voucher type">{detail.voucherType || "—"}</Field>
              <Field label="Financial year">{detail.financialYear || "—"}</Field>
              <Field label="Reference">{detail.referenceNo || "—"}</Field>
              {!detail.isManual && <Field label="Source reference">{sourceReference || "—"}</Field>}
              {postingDate && <Field label="Posting date">{postingDate}</Field>}
              {approvedBy && <Field label="Approved by">{approvedBy}</Field>}
              {(paymentMode || chequeRef) && (
                <Field label="Payment">
                  {paymentMode || "—"}
                  {chequeRef ? <span className="block text-xs text-muted-foreground">{chequeRef}</span> : null}
                </Field>
              )}
            </dl>

            {attachmentUrl && (
              <a
                href={attachmentUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
              >
                <Paperclip className="size-3.5" />
                {attachmentType || "Attachment"}
                <ExternalLink className="size-3" />
              </a>
            )}

            <div className="space-y-2">
              <span className="text-sm font-medium">Lines</span>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="p-2 font-medium">Account</th>
                      <th className="p-2 font-medium">Party / Project</th>
                      <th className="p-2 text-right font-medium">Debit</th>
                      <th className="p-2 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.id} className="border-t align-top">
                        <td className="p-2">
                          <div className="font-medium">{l.account_name || "—"}</div>
                          <div className="text-muted-foreground">{l.account_group || ""}</div>
                          {l.narration ? <div className="text-muted-foreground">{l.narration}</div> : null}
                          {l.cost_centre ? (
                            <div className="text-muted-foreground">Cost centre: {l.cost_centre}</div>
                          ) : null}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {l.party_name || "—"}
                          {l.project_name ? <div>{l.project_name}</div> : null}
                          {num(l.gst_amount) ? <div>GST {inr(l.gst_amount)}</div> : null}
                          {num(l.tds_amount) ? <div>TDS {inr(l.tds_amount)}</div> : null}
                        </td>
                        <td className="p-2 text-right tabular-nums">{num(l.debit) ? inr(l.debit) : "—"}</td>
                        <td className="p-2 text-right tabular-nums">{num(l.credit) ? inr(l.credit) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-muted/30 font-medium">
                      <td className="p-2" colSpan={2}>
                        Totals
                        {gstTotal || tdsTotal ? (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {gstTotal ? `GST ${inr(gstTotal)}` : ""} {tdsTotal ? `TDS ${inr(tdsTotal)}` : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-right tabular-nums">{inr(detail.totalDebit)}</td>
                      <td className="p-2 text-right tabular-nums">{inr(detail.totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium">Audit trail</span>
              {detail.isManual ? (
                events.length ? (
                  <ol className="space-y-3">
                    {events.map((e) => (
                      <li key={e.id} className="flex gap-3">
                        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
                          <Clock className="size-3 text-muted-foreground" />
                        </span>
                        <div className="space-y-0.5">
                          <p className="text-sm">{e.summary}</p>
                          <p className="text-xs text-muted-foreground">
                            {fmtDateTime(e.created_at)}
                            {e.actor_name ? ` · ${e.actor_name}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">No recorded events yet.</p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  System posting from {detail.sourceModule}. Its lifecycle trail lives on the source document.
                </p>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
