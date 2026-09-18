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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  DownloadIcon,
  SendIcon,
  CheckCircle2Icon,
  BanIcon,
  XCircleIcon,
  FileTextIcon,
  RefreshCwIcon,
  GitBranchIcon,
  PenLineIcon,
  ReceiptIcon,
  RocketIcon,
  BuildingIcon,
} from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { formatDate, formatDateTime, formatCurrency } from "@/lib/utils"

export const CONTRACT_STATUS_STYLE: Record<string, string> = {
  Draft: "border-muted-foreground/30 bg-muted text-muted-foreground",
  "Pending Signature": "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Expired: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Terminated: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  Cancelled: "border-muted-foreground/30 bg-muted text-muted-foreground",
  Renewed: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
}

type Detail = { contract: any; events: any[]; signatures: any[] }
type Relations = { invoices: any[]; onboarding: any[]; amendments: any[]; company: any | null }

type ActionKind = "send" | "terminate" | "renew" | "amend" | null

export function ContractDetailDrawer({
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
  const { data, isLoading, mutate } = useSWR<Detail>(open && id ? `/api/sales/contracts/${id}` : null, fetcher)
  const { data: relations } = useSWR<Relations>(
    open && id ? `/api/sales/contracts/${id}/relations` : null,
    fetcher,
  )
  const [action, setAction] = useState<ActionKind>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})

  const contract = data?.contract
  const events = data?.events ?? []
  const signatures = data?.signatures ?? []
  const hasActiveOnboarding = (relations?.onboarding ?? []).some(
    (o) => o.status !== "Completed" && o.status !== "Cancelled",
  )

  async function startOnboarding() {
    if (!id) return
    setBusy(true)
    try {
      const res = await fetch(`/api/sales/onboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_contract_id: id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const existing = body?.details?.existingCode
        toast.error(
          existing ? `An active onboarding already exists (${existing}).` : body.error || "Could not start onboarding",
        )
        return
      }
      toast.success(`Onboarding ${body.onboarding_code ?? ""} started`)
      await mutate()
      onChanged()
      window.location.assign(`/modules/sales/onboarding/${body.id}`)
    } catch {
      toast.error("Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  async function runAction(payload: Record<string, any>) {
    if (!id) return
    setBusy(true)
    try {
      const res = await fetch(`/api/sales/contracts/${id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Action failed")
        return
      }
      toast.success("Done")
      setAction(null)
      setForm({})
      await mutate()
      onChanged()
    } catch {
      toast.error("Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  const statusClass = contract ? CONTRACT_STATUS_STYLE[contract.status] || "" : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[95vw] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        {isLoading || !contract ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <DialogHeader className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <DialogTitle className="flex items-center gap-2">
                    <span className="truncate">{contract.title || contract.contract_code}</span>
                    <Badge variant="outline" className={statusClass}>
                      {contract.status}
                    </Badge>
                    {contract.relation && contract.relation !== "Original" && (
                      <Badge variant="outline">
                        {contract.relation} · V{contract.version_no}
                      </Badge>
                    )}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    {contract.contract_code} · {contract.company_name}
                    {contract.source_quotation_code ? ` · from ${contract.source_quotation_code}` : ""}
                  </DialogDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  render={
                    <a href={`/api/sales/contracts/${contract.id}/pdf`} target="_blank" rel="noreferrer" />
                  }
                >
                  <FileTextIcon data-icon="inline-start" />
                  PDF
                </Button>
              </div>
            </DialogHeader>

            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="mx-5 mt-4">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="signatures">Signatures</TabsTrigger>
                <TabsTrigger value="relations">Relations</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
              </TabsList>

              {/* Overview */}
              <TabsContent value="overview" className="p-5">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Detail label="Value" value={formatCurrency(contract.value)} />
                  <Detail label="Type" value={contract.contract_type || "—"} />
                  <Detail label="Start" value={formatDate(contract.start_date)} />
                  <Detail label="End" value={formatDate(contract.end_date)} />
                  <Detail label="Auto-renew" value={contract.auto_renew ? `Yes (${contract.renewal_term_months || "?"}m)` : "No"} />
                  <Detail label="Notice" value={contract.notice_period_days ? `${contract.notice_period_days} days` : "—"} />
                  <Detail label="Client signatory" value={contract.signed_by_client || "—"} />
                  <Detail label="Company signatory" value={contract.signed_by_company || "—"} />
                  <Detail label="Owner" value={contract.added_by_name || "—"} />
                </div>

                {contract.terms && (
                  <>
                    <Separator className="my-4" />
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Terms &amp; conditions</p>
                    <p className="whitespace-pre-wrap text-sm">{contract.terms}</p>
                  </>
                )}
                {contract.notes && (
                  <>
                    <Separator className="my-4" />
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Notes</p>
                    <p className="whitespace-pre-wrap text-sm">{contract.notes}</p>
                  </>
                )}
              </TabsContent>

              {/* Signatures */}
              <TabsContent value="signatures" className="p-5">
                {signatures.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Not yet sent for signature. Use “Send for signature” to start the e-signature round.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {signatures.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between rounded-md border border-border p-3"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {s.party} — {s.signer_name || "Unnamed"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {s.signer_email || s.role}
                            {s.signed_at ? ` · signed ${formatDateTime(s.signed_at)}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={
                              s.status === "Signed"
                                ? CONTRACT_STATUS_STYLE.Active
                                : s.status === "Declined"
                                  ? CONTRACT_STATUS_STYLE.Terminated
                                  : CONTRACT_STATUS_STYLE["Pending Signature"]
                            }
                          >
                            {s.status}
                          </Badge>
                          {canManage && s.status !== "Signed" && contract.status === "Pending Signature" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                runAction({ action: s.party === "Client" ? "sign-client" : "countersign" })
                              }
                            >
                              <PenLineIcon data-icon="inline-start" />
                              {s.party === "Client" ? "Sign" : "Countersign"}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Relations */}
              <TabsContent value="relations" className="p-5">
                <RelationSection
                  icon={<BuildingIcon className="size-4" />}
                  title="Client record"
                >
                  {relations?.company ? (
                    <div className="rounded-md border border-border p-3 text-sm">
                      <p className="font-medium">{relations.company.company_name || relations.company.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {relations.company.company_code} · {relations.company.status || "—"}
                        {relations.company.industry ? ` · ${relations.company.industry}` : ""}
                      </p>
                    </div>
                  ) : (
                    <Empty>No linked company record.</Empty>
                  )}
                </RelationSection>

                <RelationSection icon={<ReceiptIcon className="size-4" />} title="Invoices">
                  {relations?.invoices?.length ? (
                    <MiniTable
                      head={["Invoice", "Date", "Total", "Status"]}
                      rows={relations.invoices.map((i) => [
                        i.invoice_id,
                        formatDate(i.invoice_date),
                        formatCurrency(i.invoice_total),
                        i.payment_status || i.invoice_status || "—",
                      ])}
                    />
                  ) : (
                    <Empty>No linked invoices.</Empty>
                  )}
                </RelationSection>

                <RelationSection
                  icon={<RocketIcon className="size-4" />}
                  title="Onboarding"
                  action={
                    canManage && !hasActiveOnboarding ? (
                      <Button size="sm" variant="outline" disabled={busy} onClick={startOnboarding}>
                        <RocketIcon data-icon="inline-start" />
                        Start onboarding
                      </Button>
                    ) : null
                  }
                >
                  {relations?.onboarding?.length ? (
                    <MiniTable
                      head={["Code", "Date", "Stage", "Status"]}
                      rows={relations.onboarding.map((o) => [
                        <a
                          key={o.id}
                          href={`/modules/sales/onboarding/${o.id}`}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {o.onboarding_code}
                        </a>,
                        formatDate(o.onboarding_date),
                        o.current_stage || "—",
                        o.status || "—",
                      ])}
                    />
                  ) : (
                    <Empty>No onboarding linked to this contract.</Empty>
                  )}
                </RelationSection>

                <RelationSection icon={<GitBranchIcon className="size-4" />} title="Renewals &amp; amendments">
                  {relations?.amendments?.length ? (
                    <MiniTable
                      head={["Code", "Relation", "Value", "Term", "Status"]}
                      rows={relations.amendments.map((a) => [
                        a.contract_code,
                        `${a.relation} V${a.version_no}`,
                        formatCurrency(a.value),
                        `${formatDate(a.start_date)}–${formatDate(a.end_date)}`,
                        a.status,
                      ])}
                    />
                  ) : (
                    <Empty>No renewals or amendments yet.</Empty>
                  )}
                </RelationSection>
              </TabsContent>

              {/* Timeline */}
              <TabsContent value="timeline" className="p-5">
                {events.length === 0 ? (
                  <Empty>No activity recorded yet.</Empty>
                ) : (
                  <ol className="relative flex flex-col gap-4 border-l border-border pl-5">
                    {events.map((e) => (
                      <li key={e.id} className="relative">
                        <span className="absolute -left-[23px] top-1 size-2.5 rounded-full bg-primary" />
                        <p className="text-sm font-medium capitalize">{String(e.type).replace(/_/g, " ")}</p>
                        {e.description && <p className="text-sm text-muted-foreground">{e.description}</p>}
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(e.created_at)}
                          {e.actor_name ? ` · ${e.actor_name}` : ""}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </TabsContent>
            </Tabs>

            {/* Action bar */}
            {canManage && (
              <DialogFooter className="flex-wrap gap-2 border-t border-border p-4">
                {contract.status === "Draft" && (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("send")}>
                      <SendIcon data-icon="inline-start" />
                      Send for signature
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => runAction({ action: "activate" })}>
                      <CheckCircle2Icon data-icon="inline-start" />
                      Activate
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => runAction({ action: "cancel" })}>
                      <XCircleIcon data-icon="inline-start" />
                      Cancel
                    </Button>
                  </>
                )}
                {contract.status === "Pending Signature" && (
                  <Button size="sm" disabled={busy} onClick={() => runAction({ action: "activate" })}>
                    <CheckCircle2Icon data-icon="inline-start" />
                    Activate
                  </Button>
                )}
                {contract.status === "Active" && (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("renew")}>
                      <RefreshCwIcon data-icon="inline-start" />
                      Renew
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("amend")}>
                      <GitBranchIcon data-icon="inline-start" />
                      Amend
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setAction("terminate")}
                    >
                      <BanIcon data-icon="inline-start" />
                      Terminate
                    </Button>
                  </>
                )}
                {contract.status === "Expired" && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("renew")}>
                    <RefreshCwIcon data-icon="inline-start" />
                    Renew
                  </Button>
                )}
              </DialogFooter>
            )}
          </>
        )}

        {/* Secondary action dialogs */}
        <Dialog open={action !== null} onOpenChange={(o) => !o && setAction(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {action === "send" && "Send for signature"}
                {action === "terminate" && "Terminate contract"}
                {action === "renew" && "Renew contract"}
                {action === "amend" && "Amend contract"}
              </DialogTitle>
              <DialogDescription>
                {action === "send" && "Enter signer details. The client signs first, then the company countersigns."}
                {action === "terminate" && "Record a reason. This ends the active contract."}
                {action === "renew" && "Create a successor contract in Draft, carrying over the terms."}
                {action === "amend" && "Create an amendment in Draft, linked to this contract."}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 py-2">
              {action === "send" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="client_email">Client signer email</FieldLabel>
                    <Input
                      id="client_email"
                      type="email"
                      value={form.client_email || ""}
                      onChange={(e) => setForm((f) => ({ ...f, client_email: e.target.value }))}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="company_email">Company signer email</FieldLabel>
                    <Input
                      id="company_email"
                      type="email"
                      value={form.company_email || ""}
                      onChange={(e) => setForm((f) => ({ ...f, company_email: e.target.value }))}
                    />
                  </Field>
                </>
              )}
              {action === "terminate" && (
                <Field>
                  <FieldLabel htmlFor="reason">Reason</FieldLabel>
                  <Textarea
                    id="reason"
                    rows={3}
                    value={form.reason || ""}
                    onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  />
                </Field>
              )}
              {(action === "renew" || action === "amend") && (
                <>
                  <Field>
                    <FieldLabel htmlFor="new_value">New value (optional)</FieldLabel>
                    <Input
                      id="new_value"
                      type="number"
                      value={form.value || ""}
                      onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                    />
                  </Field>
                  {action === "renew" && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field>
                        <FieldLabel htmlFor="new_start">Start</FieldLabel>
                        <Input
                          id="new_start"
                          type="date"
                          value={form.start_date || ""}
                          onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="new_end">End</FieldLabel>
                        <Input
                          id="new_end"
                          type="date"
                          value={form.end_date || ""}
                          onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setAction(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy || (action === "terminate" && !form.reason)}
                onClick={() => {
                  if (action === "send")
                    runAction({
                      action: "send-signature",
                      client_email: form.client_email,
                      company_email: form.company_email,
                    })
                  else if (action === "terminate") runAction({ action: "terminate", reason: form.reason })
                  else if (action === "renew")
                    runAction({
                      action: "renew",
                      value: form.value ? Number(form.value) : undefined,
                      start_date: form.start_date || undefined,
                      end_date: form.end_date || undefined,
                    })
                  else if (action === "amend")
                    runAction({ action: "amend", value: form.value ? Number(form.value) : undefined })
                }}
              >
                {busy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

function RelationSection({
  icon,
  title,
  children,
  action,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
        <div className="flex items-center gap-2">
          {icon}
          <span>{title}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">{children}</p>
}

function MiniTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j} className={j === 0 ? "font-medium" : "text-muted-foreground"}>
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
