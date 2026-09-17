"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ContractStatusBadge } from "@/components/legal/contract-status-badge"
import { CONTRACT_STATUSES, sourceMeta, type GeneratedContract, type ContractStatus } from "@/lib/legal-contracts-shared"
import { Download, ExternalLink, Loader2, Mail, RefreshCw, History, FileText, ArrowRight } from "lucide-react"

function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—"
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
}

function fmtDateTime(d: string | null | undefined) {
  if (!d) return "—"
  const dt = new Date(d)
  return isNaN(dt.getTime())
    ? "—"
    : dt.toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{value ?? "—"}</span>
    </div>
  )
}

// Statuses that make sense to move a generated contract into. The full catalog
// stays available for edge cases; these are surfaced as one-tap quick actions.
const QUICK_TRANSITIONS: Partial<Record<ContractStatus, ContractStatus[]>> = {
  Draft: ["Generated", "In Review", "Cancelled"],
  Generated: ["In Review", "Sent", "Active", "Cancelled"],
  "In Review": ["Approved", "Draft", "Cancelled"],
  Approved: ["Sent", "Active", "Cancelled"],
  Sent: ["Viewed", "Signed", "Active", "Cancelled"],
  Viewed: ["Signed", "Active", "Cancelled"],
  Signed: ["Active", "Terminated"],
  Active: ["Signed", "Terminated", "Expired"],
}

type EventRow = {
  id: number
  event_type: string
  summary: string
  actor_name: string | null
  created_at: string | null
  detail: Record<string, unknown> | null
}

export function ContractDetailDialog({ contractId, onClose }: { contractId: number; onClose: () => void }) {
  const contractKey = `/api/legal/contracts/${contractId}`
  const eventsKey = `/api/legal/contracts/${contractId}/events`
  const { data, isLoading, mutate } = useSWR<{ contract: GeneratedContract }>(contractKey, fetcher)
  const { data: activity, mutate: mutateActivity } = useSWR<{ events: EventRow[]; chain: GeneratedContract[] }>(
    eventsKey,
    fetcher,
  )
  const c = data?.contract
  const events = activity?.events || []
  const chain = activity?.chain || []

  const [busy, setBusy] = useState(false)
  const [nextStatus, setNextStatus] = useState<string>("")
  const [renewOpen, setRenewOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)

  function refreshAll() {
    mutate()
    mutateActivity()
  }

  async function changeStatus(to: string) {
    if (!c || !to || to === c.status) return
    setBusy(true)
    try {
      const res = await fetch(`${contractKey}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(`Status updated to ${to}`)
        setNextStatus("")
        refreshAll()
      } else {
        toast.error(d.error || "Could not update status")
      }
    } finally {
      setBusy(false)
    }
  }

  const quick = c ? QUICK_TRANSITIONS[c.status as ContractStatus] || [] : []

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-h-[94vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              {c?.title || "Contract"}
              {c && <ContractStatusBadge status={c.status} />}
            </DialogTitle>
            <DialogDescription>
              {c ? `${c.contract_uid}${c.reference_no ? ` · ${c.reference_no}` : ""}` : "Loading contract…"}
            </DialogDescription>
          </DialogHeader>

          {isLoading || !c ? (
            <div className="flex items-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4">
                  <Field label="Type" value={c.contract_type} />
                  <Field label="Category" value={c.category} />
                  <Field label="Source" value={sourceMeta(c.source).label.replace(/ \(.*\)/, "")} />
                  <Field label="Counterparty" value={c.party_name} />
                  <Field label="Version" value={`v${c.version}`} />
                  <Field label="From template" value={c.template_name} />
                </div>
                <div className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4">
                  <Field label="Effective" value={fmtDate(c.effective_date)} />
                  <Field label="Start" value={fmtDate(c.start_date)} />
                  <Field label="End" value={fmtDate(c.end_date)} />
                  <Field label="Renewal" value={fmtDate(c.renewal_date)} />
                </div>
                <div className="rounded-lg border bg-card p-4">
                  <Field label="Generated by" value={`${c.generated_by_name || "—"} · ${fmtDate(c.created_at)}`} />
                </div>

                {/* Status actions */}
                <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Change status</span>
                  {quick.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {quick.map((s) => (
                        <Button key={s} size="sm" variant="outline" disabled={busy} onClick={() => changeStatus(s)}>
                          {s}
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Select value={nextStatus} onValueChange={setNextStatus}>
                      <SelectTrigger className="h-9 flex-1">
                        <SelectValue placeholder="Set any status…" />
                      </SelectTrigger>
                      <SelectContent>
                        {CONTRACT_STATUSES.filter((s) => s !== c.status).map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" disabled={busy || !nextStatus} onClick={() => changeStatus(nextStatus)}>
                      Apply
                    </Button>
                  </div>
                </div>

                {/* Primary actions */}
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <a href={`${contractKey}/pdf?download=1`}>
                      <Download data-icon="inline-start" /> Download PDF
                    </a>
                  </Button>
                  <Button variant="outline" asChild>
                    <a href={`${contractKey}/pdf`} target="_blank" rel="noreferrer">
                      <ExternalLink data-icon="inline-start" /> Open PDF
                    </a>
                  </Button>
                  <Button variant="outline" onClick={() => setEmailOpen(true)}>
                    <Mail data-icon="inline-start" /> Email
                  </Button>
                  <Button variant="outline" onClick={() => setRenewOpen(true)}>
                    <RefreshCw data-icon="inline-start" /> Renew
                  </Button>
                </div>
              </div>

              <div className="min-w-0">
                <Tabs defaultValue="document">
                  <TabsList>
                    <TabsTrigger value="document">
                      <FileText className="size-4" data-icon="inline-start" /> Document
                    </TabsTrigger>
                    <TabsTrigger value="activity">
                      <History className="size-4" data-icon="inline-start" /> Activity{events.length ? ` (${events.length})` : ""}
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="document">
                    <div className="max-h-[64vh] overflow-y-auto rounded-lg border bg-white p-6 text-sm leading-relaxed text-slate-900 shadow-sm">
                      <div
                        className="[&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:w-full [&_td]:border [&_td]:border-slate-300 [&_td]:p-1.5"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.content) }}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="activity">
                    <div className="max-h-[64vh] overflow-y-auto rounded-lg border bg-card p-4">
                      {chain.length > 1 && (
                        <div className="mb-4">
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Renewal chain</span>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {chain.map((link, i) => (
                              <span key={link.id} className="flex items-center gap-1.5">
                                <span
                                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                                    link.id === c.id ? "border-primary bg-primary/5 font-medium text-foreground" : "text-muted-foreground"
                                  }`}
                                >
                                  {link.reference_no || link.contract_uid}
                                </span>
                                {i < chain.length - 1 && <ArrowRight className="size-3.5 text-muted-foreground" />}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Audit history</span>
                      <ol className="mt-2 flex flex-col gap-3">
                        {events.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No activity yet.</li>}
                        {events.map((e) => (
                          <li key={e.id} className="flex gap-3">
                            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60" />
                            <div className="flex flex-col">
                              <span className="text-sm text-foreground">{e.summary}</span>
                              <span className="text-xs text-muted-foreground">
                                {fmtDateTime(e.created_at)}
                                {e.actor_name ? ` · ${e.actor_name}` : ""}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {c && renewOpen && (
        <RenewDialog
          contractId={c.id}
          defaults={{ startDate: c.end_date }}
          onClose={() => setRenewOpen(false)}
          onDone={() => {
            setRenewOpen(false)
            refreshAll()
          }}
        />
      )}
      {c && emailOpen && <EmailDialog contractId={c.id} onClose={() => setEmailOpen(false)} onSent={refreshAll} />}
    </>
  )
}

function RenewDialog({
  contractId,
  defaults,
  onClose,
  onDone,
}: {
  contractId: number
  defaults: { startDate: string | null }
  onClose: () => void
  onDone: () => void
}) {
  const [startDate, setStartDate] = useState(defaults.startDate ? String(defaults.startDate).slice(0, 10) : "")
  const [endDate, setEndDate] = useState("")
  const [renewalDate, setRenewalDate] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch(`/api/legal/contracts/${contractId}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effectiveDate: startDate || null,
          startDate: startDate || null,
          endDate: endDate || null,
          renewalDate: renewalDate || null,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(`Renewed as ${d.contract?.reference_no || d.contract?.contract_uid || "a new contract"}`)
        onDone()
      } else {
        toast.error(d.error || "Could not renew contract")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Renew contract</DialogTitle>
          <DialogDescription>
            Creates a new contract from the same template and source. The current contract is preserved and marked Expired.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>New start date</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>New end date</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Renewal reminder date</Label>
            <Input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Renewing…" : "Create renewal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmailDialog({ contractId, onClose, onSent }: { contractId: number; onClose: () => void; onSent: () => void }) {
  const { data } = useSWR<{ ok: boolean; to: string; subject: string }>(`/api/legal/contracts/${contractId}/email`, fetcher)
  const [to, setTo] = useState("")
  const [cc, setCc] = useState("")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)

  // Prefill from the server draft once it arrives (without clobbering edits).
  if (data && !touched) {
    if (data.to && !to) setTo(data.to)
    if (data.subject && !subject) setSubject(data.subject)
  }

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch(`/api/legal/contracts/${contractId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, cc: cc || null, subject, message: message || null }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(`Contract emailed to ${d.to || to}`)
        onSent()
        onClose()
      } else {
        toast.error(d.error || "Could not send email")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Email contract</DialogTitle>
          <DialogDescription>The generated PDF is attached and a secure in-app link is included.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>To</Label>
            <Input
              type="email"
              value={to}
              onChange={(e) => {
                setTouched(true)
                setTo(e.target.value)
              }}
              placeholder="counterparty@example.com"
            />
          </div>
          <div className="grid gap-2">
            <Label>Cc (optional)</Label>
            <Input type="text" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="legal@yourcompany.com" />
          </div>
          <div className="grid gap-2">
            <Label>Subject</Label>
            <Input
              value={subject}
              onChange={(e) => {
                setTouched(true)
                setSubject(e.target.value)
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label>Message (optional)</Label>
            <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add a short note…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !to.trim()}>
            {busy ? "Sending…" : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
