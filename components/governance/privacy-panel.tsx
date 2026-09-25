"use client"

import { useState } from "react"
import useSWR from "swr"
import { AlertTriangle, CheckCircle2, Clock, Download, ShieldCheck, Trash2, UserCog } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || "Request failed")
  return data
}

function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    approved: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    executed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    requested: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    export_ready: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    rejected: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
    cancelled: "bg-muted text-muted-foreground",
  }
  return <Badge className={tone[status] ?? "bg-muted text-muted-foreground"}>{status.replace(/_/g, " ")}</Badge>
}

export function PrivacyPanel() {
  return (
    <div className="flex flex-col gap-6">
      <TenantDeletionSection />
      <SubjectRequestsSection />
      <ConsentSection />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tenant deletion
// ---------------------------------------------------------------------------

function TenantDeletionSection() {
  const { data, mutate, isLoading } = useSWR("/api/admin/privacy/tenant-deletion", fetcher)
  const [reason, setReason] = useState("")
  const [coolingDays, setCoolingDays] = useState("")
  const [proofNote, setProofNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const active = data?.active
  const readiness = data?.readiness
  const cooling = data?.cooling

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Trash2 className="size-4 text-muted-foreground" />
          Tenant deletion
        </CardTitle>
        <CardDescription>
          Safe offboarding: a cooling period, a mandatory data export, a legal-hold block, and proof of
          backup/retention obligations must all clear before final approval and execution.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-6">
        {error ? (
          <p className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
            <AlertTriangle className="size-4" /> {error}
          </p>
        ) : null}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !active ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">No active deletion request.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="td-reason">Reason</Label>
                <Input id="td-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Contract ended" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="td-cooling">
                  Cooling period (days{cooling ? `, ${cooling.min}–${cooling.max}` : ""})
                </Label>
                <Input
                  id="td-cooling"
                  value={coolingDays}
                  onChange={(e) => setCoolingDays(e.target.value)}
                  placeholder={cooling ? String(cooling.default) : "30"}
                  inputMode="numeric"
                />
              </div>
            </div>
            <div>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    post("/api/admin/privacy/tenant-deletion", {
                      reason,
                      coolingDays: coolingDays ? Number(coolingDays) : undefined,
                    }),
                  )
                }
              >
                Request tenant deletion
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={active.status} />
              <span className="text-sm text-muted-foreground">
                Requested by {active.requestedByName ?? "—"} · {new Date(active.createdAt).toLocaleString()}
              </span>
            </div>

            <ul className="flex flex-col gap-2 text-sm">
              <ReadinessRow
                ok={active.coolingElapsed}
                label={
                  active.coolingElapsed
                    ? "Cooling period elapsed"
                    : `Cooling period: ${active.coolingDaysRemaining} day(s) remaining (ends ${new Date(active.coolingEndsAt).toLocaleDateString()})`
                }
                icon={<Clock className="size-4" />}
              />
              <ReadinessRow
                ok={active.exportCompleted}
                label={active.exportCompleted ? `Data export completed (job #${active.exportJobId})` : "Data export not yet produced"}
                icon={<Download className="size-4" />}
              />
              <ReadinessRow
                ok={(readiness?.activeLegalHolds ?? 0) === 0}
                label={
                  (readiness?.activeLegalHolds ?? 0) === 0
                    ? "No active legal holds"
                    : `Blocked by ${readiness.activeLegalHolds} active legal hold(s)`
                }
                icon={<ShieldCheck className="size-4" />}
              />
              <ReadinessRow
                ok={active.retentionProven}
                label={active.retentionProven ? "Backup/retention obligations proven" : "Backup/retention obligations not yet proven"}
                icon={<CheckCircle2 className="size-4" />}
              />
            </ul>

            {active.status !== "approved" && active.status !== "executed" ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => post(`/api/admin/privacy/tenant-deletion/${active.id}`, { action: "export" }))}>
                  <Download className="mr-1.5 size-3.5" /> Produce export
                </Button>
              </div>
            ) : null}

            {!active.retentionProven && active.status !== "executed" ? (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <Label htmlFor="td-proof" className="text-sm font-medium">
                  Prove backup/retention obligations
                </Label>
                <Textarea
                  id="td-proof"
                  value={proofNote}
                  onChange={(e) => setProofNote(e.target.value)}
                  placeholder="e.g. Final backup archived to cold storage; statutory finance retention satisfied by export job."
                  rows={2}
                />
                <div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => post(`/api/admin/privacy/tenant-deletion/${active.id}`, { action: "prove", proven: true, note: proofNote }))}>
                    Record proof
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t pt-4">
              {active.status !== "executed" ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => post(`/api/admin/privacy/tenant-deletion/${active.id}`, { action: "cancel", reason: "Withdrawn by owner" }))}>
                  Withdraw
                </Button>
              ) : null}
              {active.status !== "approved" && active.status !== "executed" ? (
                <Button size="sm" disabled={busy || !readiness?.canApprove} onClick={() => run(() => post(`/api/admin/privacy/tenant-deletion/${active.id}`, { action: "approve" }))}>
                  Final approval
                </Button>
              ) : null}
              {active.status === "approved" ? (
                <Button size="sm" variant="destructive" disabled={busy || !readiness?.canExecute} onClick={() => run(() => post(`/api/admin/privacy/tenant-deletion/${active.id}`, { action: "execute" }))}>
                  Execute deletion
                </Button>
              ) : null}
            </div>
            {readiness && !readiness.canApprove && active.status !== "approved" && active.status !== "executed" && readiness.reasons?.length ? (
              <p className="text-xs text-muted-foreground">Outstanding: {readiness.reasons.join("; ")}</p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ReadinessRow({ ok, label, icon }: { ok: boolean; label: string; icon: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>{icon}</span>
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Data-subject requests
// ---------------------------------------------------------------------------

function SubjectRequestsSection() {
  const { data, mutate, isLoading } = useSWR("/api/admin/privacy/subject-requests", fetcher)
  const [kind, setKind] = useState("export")
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const requests: any[] = data?.requests ?? []
  const kinds: { key: string; label: string }[] = data?.kinds ?? []

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <UserCog className="size-4 text-muted-foreground" />
          Data-subject requests
        </CardTitle>
        <CardDescription>
          Export, anonymize, or erase one person&apos;s personal data across the ERP. Erase and anonymize require
          approval; a legal hold blocks a location, and an active retention policy downgrades an erase to
          anonymization.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-6">
        {error ? (
          <p className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
            <AlertTriangle className="size-4" /> {error}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.key} value={k.key}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="sr-email">Subject email</Label>
            <Input id="sr-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={busy || !email.trim()}
              onClick={() => run(async () => {
                await post("/api/admin/privacy/subject-requests", { kind, subjectEmail: email, subjectName: name })
                setEmail("")
                setName("")
              })}
            >
              Create request
            </Button>
          </div>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : requests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No requests yet.
                  </TableCell>
                </TableRow>
              ) : (
                requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.kindLabel}</TableCell>
                    <TableCell>{r.subjectEmail}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-sm text-muted-foreground" title={r.resultSummary ?? ""}>
                      {r.resultSummary ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {r.status === "pending" && r.kind !== "export" ? (
                          <>
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => post(`/api/admin/privacy/subject-requests/${r.id}/decision`, { decision: "approve" }))}>
                              Approve
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => post(`/api/admin/privacy/subject-requests/${r.id}/decision`, { decision: "reject" }))}>
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {(r.kind === "export" && r.status === "pending") || r.status === "approved" ? (
                          <Button size="sm" disabled={busy} onClick={() => run(() => post(`/api/admin/privacy/subject-requests/${r.id}/run`, {}))}>
                            Run
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Consent ledger
// ---------------------------------------------------------------------------

function ConsentSection() {
  const { data, mutate, isLoading } = useSWR("/api/admin/privacy/consent", fetcher)
  const [purpose, setPurpose] = useState("marketing")
  const [method, setMethod] = useState("web_form")
  const [email, setEmail] = useState("")
  const [notice, setNotice] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const states: any[] = data?.states ?? []
  const purposes: { key: string; label: string }[] = data?.purposes ?? []
  const methods: string[] = data?.methods ?? []

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          Consent &amp; notice
        </CardTitle>
        <CardDescription>
          Record explicit consent and the notice shown for marketing, recruitment, and screen-capture purposes.
          Consent is an append-only ledger; withdrawal revokes the lawful basis while preserving full history.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-6">
        {error ? (
          <p className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
            <AlertTriangle className="size-4" /> {error}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-5">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="c-email">Subject email</Label>
            <Input id="c-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Purpose</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {purposes.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={busy || !email.trim()}
              onClick={() => run(async () => {
                await post("/api/admin/privacy/consent", { subjectEmail: email, purpose, method, noticeText: notice })
                setEmail("")
                setNotice("")
              })}
            >
              Record
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="c-notice">Notice text shown to subject (optional)</Label>
          <Textarea id="c-notice" value={notice} onChange={(e) => setNotice(e.target.value)} rows={2} placeholder="The exact notice/disclosure presented when consent was captured." />
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : states.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No consent recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                states.map((s) => (
                  <TableRow key={`${s.subjectEmail}:${s.purpose}`}>
                    <TableCell className="font-medium">{s.subjectEmail}</TableCell>
                    <TableCell>{s.purposeLabel}</TableCell>
                    <TableCell>
                      <Badge className={s.granted ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted text-muted-foreground"}>
                        {s.granted ? "granted" : "withdrawn"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(s.method ?? "").replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "—"}</TableCell>
                    <TableCell className="text-right">
                      {s.granted ? (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => post("/api/admin/privacy/consent/withdraw", { subjectEmail: s.subjectEmail, purpose: s.purpose }))}>
                          Withdraw
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
