"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Loader2Icon,
  BuildingIcon,
  UserIcon,
  TargetIcon,
  FileTextIcon,
  DownloadIcon,
  SendIcon,
  CheckCircle2Icon,
  XCircleIcon,
  BanIcon,
  CopyIcon,
  GitBranchIcon,
  CalendarClockIcon,
} from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { formatDate, formatDateTime, formatCurrency } from "@/lib/utils"

type Detail = {
  quotation: any
  items: any[]
  events: any[]
  versions: any[]
}

type ActionKind = "reject" | "renew" | null

const STATUS_STYLE: Record<string, string> = {
  Draft: "border-muted-foreground/30 bg-muted text-muted-foreground",
  Sent: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Accepted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Rejected: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  Expired: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Cancelled: "border-muted-foreground/30 bg-muted text-muted-foreground",
}

const REJECTION_REASONS = ["Price", "Competitor", "Scope", "Timing", "Budget", "Other"]

export function QuotationDetailDrawer({
  id,
  open,
  onOpenChange,
  canManage,
  onChanged,
}: {
  id: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  canManage: boolean
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<Detail>(open && id ? `/api/sales/quotations/${id}` : null, fetcher)
  const [action, setAction] = useState<ActionKind>(null)
  const [busy, setBusy] = useState(false)

  const q = data?.quotation
  const items = data?.items ?? []
  const events = data?.events ?? []
  const versions = data?.versions ?? []

  const currency = q?.currency || "INR"
  const money = (n: any) => formatCurrency(Number(n) || 0, currency)

  function openPdf(download = false) {
    if (!id) return
    window.open(`/api/sales/quotations/${id}/pdf${download ? "?download=1" : ""}`, "_blank")
  }

  async function doAction(body: Record<string, any>, successMsg: string) {
    if (!id) return
    setBusy(true)
    try {
      const res = await fetch(`/api/sales/quotations/${id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Action failed")
      toast.success(successMsg)
      setAction(null)
      mutate()
      onChanged()
    } catch (err: any) {
      toast.error(err.message || "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const gstOn = q?.gst_treatment && q.gst_treatment !== "None"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {isLoading || !q ? (
          <div className="flex items-center justify-center py-16">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="font-mono text-base">
                  {q.quote_code}
                  {q.version && q.version > 1 ? <span className="ml-1 text-muted-foreground">v{q.version}</span> : null}
                </DialogTitle>
                <Badge variant="outline" className={STATUS_STYLE[q.status] || ""}>
                  {q.status}
                </Badge>
                {q.is_current === 0 || q.is_current === false ? (
                  <Badge variant="outline" className="text-muted-foreground">
                    Superseded
                  </Badge>
                ) : null}
              </div>
              <DialogDescription>
                {q.opportunity_name || "Quotation"} · {formatDate(q.quote_date)}
                {q.valid_until ? ` · valid until ${formatDate(q.valid_until)}` : ""}
              </DialogDescription>
            </DialogHeader>

            {action ? (
              <ActionForm
                kind={action}
                quotation={q}
                busy={busy}
                onCancel={() => setAction(null)}
                onSubmit={doAction}
              />
            ) : (
              <div className="flex flex-col gap-5 py-2">
                {/* CRM links */}
                <section className="grid gap-3 sm:grid-cols-3">
                  <InfoTile icon={<BuildingIcon className="size-4" />} label="Company" value={q.company_name} />
                  <InfoTile
                    icon={<UserIcon className="size-4" />}
                    label="Contact"
                    value={q.contact_person}
                    sub={q.contact_email || q.contact_phone}
                  />
                  <InfoTile
                    icon={<TargetIcon className="size-4" />}
                    label="Source"
                    value={q.source_type || "Manual"}
                    sub={q.reference}
                  />
                </section>

                <section className="grid gap-3 sm:grid-cols-3">
                  <InfoTile label="Owner" value={q.owner_name} />
                  <InfoTile label="Currency" value={currency} sub={gstOn ? q.gst_treatment : "No GST"} />
                  <InfoTile label="Added by" value={q.added_by_name} sub={formatDate(q.created_at)} />
                </section>

                {/* Line items */}
                <Section title="Line items">
                  <div className="overflow-x-auto rounded-md border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8">#</TableHead>
                          <TableHead>Item</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Rate</TableHead>
                          {gstOn ? <TableHead className="text-right">GST</TableHead> : null}
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={gstOn ? 6 : 5} className="py-6 text-center text-sm text-muted-foreground">
                              No line items.
                            </TableCell>
                          </TableRow>
                        ) : (
                          items.map((it) => (
                            <TableRow key={it.id}>
                              <TableCell className="text-muted-foreground">{it.line_no}</TableCell>
                              <TableCell>
                                <div className="flex flex-col">
                                  <span className="font-medium">{it.name}</span>
                                  {it.description ? (
                                    <span className="text-xs text-muted-foreground">{it.description}</span>
                                  ) : null}
                                  {it.hsn_sac ? (
                                    <span className="text-xs text-muted-foreground">HSN/SAC {it.hsn_sac}</span>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {Number(it.quantity)}
                                {it.unit ? ` ${it.unit}` : ""}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{money(it.rate)}</TableCell>
                              {gstOn ? (
                                <TableCell className="text-right tabular-nums">{Number(it.tax_rate)}%</TableCell>
                              ) : null}
                              <TableCell className="text-right font-medium tabular-nums">{money(it.line_total)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </Section>

                {/* Totals */}
                <div className="ml-auto w-full max-w-xs rounded-md border border-border bg-muted/40 p-4">
                  <dl className="flex flex-col gap-1.5 text-sm">
                    <Row label="Subtotal" value={money(q.subtotal)} />
                    {Number(q.discount_total) > 0 && <Row label="Discount" value={`- ${money(q.discount_total)}`} />}
                    <Row label="Taxable value" value={money(q.taxable_value)} muted />
                    {Number(q.cgst_total) > 0 && <Row label="CGST" value={money(q.cgst_total)} muted />}
                    {Number(q.sgst_total) > 0 && <Row label="SGST" value={money(q.sgst_total)} muted />}
                    {Number(q.igst_total) > 0 && <Row label="IGST" value={money(q.igst_total)} muted />}
                    {Number(q.round_off) !== 0 && <Row label="Round off" value={money(q.round_off)} muted />}
                    <Separator className="my-1" />
                    <div className="flex justify-between text-base font-semibold">
                      <dt>Grand total</dt>
                      <dd className="tabular-nums">{money(q.grand_total)}</dd>
                    </div>
                  </dl>
                </div>

                {/* Terms & notes */}
                {(q.payment_terms || q.delivery_terms || q.terms_text || q.customer_notes) && (
                  <Section title="Terms & notes">
                    <div className="flex flex-col gap-2 text-sm">
                      {q.payment_terms && (
                        <p>
                          <span className="text-muted-foreground">Payment: </span>
                          {q.payment_terms}
                        </p>
                      )}
                      {q.delivery_terms && (
                        <p>
                          <span className="text-muted-foreground">Delivery: </span>
                          {q.delivery_terms}
                        </p>
                      )}
                      {q.terms_text && <p className="whitespace-pre-wrap">{q.terms_text}</p>}
                      {q.customer_notes && (
                        <p className="whitespace-pre-wrap text-muted-foreground">{q.customer_notes}</p>
                      )}
                    </div>
                  </Section>
                )}

                {q.rejection_reason && (
                  <Section title="Rejection">
                    <p className="text-sm">
                      <Badge variant="outline">{q.rejection_reason}</Badge>
                      {q.rejection_notes ? <span className="ml-2 text-muted-foreground">{q.rejection_notes}</span> : null}
                    </p>
                  </Section>
                )}

                {/* Versions */}
                {versions.length > 1 && (
                  <Section title="Revisions">
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                      {versions.map((v) => (
                        <li key={v.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {v.quote_code} v{v.version}
                            </span>
                            {v.is_current ? <Badge variant="secondary">Current</Badge> : null}
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="tabular-nums text-muted-foreground">{money(v.grand_total)}</span>
                            <Badge variant="outline" className={STATUS_STYLE[v.status] || ""}>
                              {v.status}
                            </Badge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {/* Timeline */}
                {events.length > 0 && (
                  <Section title="Activity">
                    <ul className="flex flex-col gap-3">
                      {events.map((e) => (
                        <li key={e.id} className="flex gap-3 text-sm">
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                          <div className="flex flex-col">
                            <span>{e.description || e.event_type}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatDateTime(e.created_at)}
                              {e.actor_name ? ` · ${e.actor_name}` : ""}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
              </div>
            )}

            {!action && (
              <>
                <Separator />
                <DialogFooter className="flex-wrap gap-2 sm:justify-start">
                  <Button size="sm" variant="outline" onClick={() => openPdf(false)}>
                    <FileTextIcon data-icon="inline-start" /> View PDF
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openPdf(true)}>
                    <DownloadIcon data-icon="inline-start" /> Download
                  </Button>
                  {canManage && (
                    <>
                      {q.status === "Draft" && (
                        <Button size="sm" disabled={busy} onClick={() => doAction({ action: "send" }, "Quotation sent")}>
                          <SendIcon data-icon="inline-start" /> Mark as sent
                        </Button>
                      )}
                      {q.status === "Sent" && (
                        <>
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => doAction({ action: "accept" }, "Quotation accepted")}
                          >
                            <CheckCircle2Icon data-icon="inline-start" /> Accept
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setAction("reject")}>
                            <XCircleIcon data-icon="inline-start" /> Reject
                          </Button>
                        </>
                      )}
                      {q.status === "Expired" && (
                        <Button size="sm" variant="outline" onClick={() => setAction("renew")}>
                          <CalendarClockIcon data-icon="inline-start" /> Renew validity
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => doAction({ action: "revise" }, "New revision created")}
                      >
                        <GitBranchIcon data-icon="inline-start" /> Revise
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => doAction({ action: "duplicate" }, "Quotation duplicated")}
                      >
                        <CopyIcon data-icon="inline-start" /> Duplicate
                      </Button>
                      {q.status === "Accepted" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => doAction({ action: "convert-invoice" }, "Converted to invoice")}
                          >
                            Convert to invoice
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => doAction({ action: "convert-contract" }, "Converted to contract")}
                          >
                            Convert to contract
                          </Button>
                        </>
                      )}
                      {["Draft", "Sent"].includes(q.status) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={busy}
                          onClick={() => doAction({ action: "cancel" }, "Quotation cancelled")}
                        >
                          <BanIcon data-icon="inline-start" /> Cancel
                        </Button>
                      )}
                    </>
                  )}
                </DialogFooter>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={muted ? "tabular-nums text-muted-foreground" : "tabular-nums"}>{value}</dd>
    </div>
  )
}

function InfoTile({
  icon,
  label,
  value,
  sub,
}: {
  icon?: React.ReactNode
  label: string
  value: string | null | undefined
  sub?: string | null
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1 truncate text-sm font-medium">{value || "—"}</p>
      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function ActionForm({
  kind,
  quotation,
  busy,
  onCancel,
  onSubmit,
}: {
  kind: Exclude<ActionKind, null>
  quotation: any
  busy: boolean
  onCancel: () => void
  onSubmit: (body: Record<string, any>, successMsg: string) => void
}) {
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState("")
  const [validUntil, setValidUntil] = useState(
    quotation.valid_until ? String(quotation.valid_until).slice(0, 10) : "",
  )
  const [error, setError] = useState<string | null>(null)

  function submit() {
    setError(null)
    if (kind === "reject") {
      onSubmit({ action: "reject", reason: reason || null, notes: notes || null }, "Quotation rejected")
    } else if (kind === "renew") {
      if (!validUntil) {
        setError("Pick a new validity date")
        return
      }
      onSubmit({ action: "renew", valid_until: validUntil }, "Validity extended")
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <h3 className="text-sm font-semibold">{kind === "reject" ? "Reject quotation" : "Renew validity"}</h3>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {kind === "reject" && (
        <>
          <Field>
            <FieldLabel>Reason</FieldLabel>
            <Select value={reason} onValueChange={(v) => setReason(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {REJECTION_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="reject_notes">Notes</FieldLabel>
            <Textarea id="reject_notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </>
      )}

      {kind === "renew" && (
        <Field>
          <FieldLabel htmlFor="valid_until">New valid until</FieldLabel>
          <Input
            id="valid_until"
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </Field>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
          {kind === "reject" ? "Reject" : "Renew"}
        </Button>
      </div>
    </div>
  )
}
