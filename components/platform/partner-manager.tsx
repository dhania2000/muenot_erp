"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Terms = {
  revenueShareBps: number
  refundWindowDays: number
  contractStart: string
  contractEnd: string | null
  eligibilityMonths: number | null
}
type Partner = {
  id: number
  name: string
  kind: string
  status: "active" | "suspended" | "terminated"
  contactEmail: string | null
  referralCode: string | null
  terms: Terms
}
type Commission = { id: number; invoiceNumber: string; kind: "commission" | "clawback"; amount: string; currency: string; shareBps: number; settledAt: string | null }
type Detail = {
  partner: Partner
  referrals: { id: number; tenantId: number; tenantName: string | null; ownership: string; source: string; status: string; attributedAt: string; endedAt: string | null }[]
  members: { userId: number; name: string | null; email: string | null; status: string; revokedAt: string | null }[]
  commissions: Commission[]
  totals: Record<string, string | number>
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? "Request failed")
  return body
}

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? "Request failed")
  return body
}

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  suspended: "secondary",
  terminated: "destructive",
  cancelled: "outline",
  transferred: "outline",
  revoked: "outline",
}

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`

export function PartnerManager({ canManage }: { canManage: boolean }) {
  const list = useSWR<{ partners: Partner[] }>("/api/platform/partners", fetcher)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed")
    } finally {
      setBusy(null)
    }
  }

  const settle = () =>
    run("settle", async () => {
      const r = await call("/api/platform/partners/settle", { method: "POST" })
      toast.success(`Settled ${r.settled.length}, deferred ${r.skipped.length}, failed ${r.failed.length}`)
      await list.mutate()
    })

  return (
    <div className="flex flex-col gap-6">
      {canManage && <CreatePartnerForm onCreated={(id) => { list.mutate(); setSelected(id) }} />}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Partner organizations</CardTitle>
            <CardDescription>Select a partner to manage referrals, members and its ledger.</CardDescription>
          </div>
          {canManage && (
            <Button variant="outline" size="sm" onClick={settle} disabled={busy === "settle"}>
              {busy === "settle" && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Run settlement
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {list.error ? (
            <p className="text-sm text-destructive">{list.error.message}</p>
          ) : !list.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : list.data.partners.length === 0 ? (
            <p className="text-sm text-muted-foreground">No partners yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Share</TableHead>
                  <TableHead>Refund window</TableHead>
                  <TableHead>Referral code</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.partners.map((p) => (
                  <TableRow key={p.id} data-state={selected === p.id ? "selected" : undefined}>
                    <TableCell>
                      <button type="button" className="font-medium underline-offset-4 hover:underline" onClick={() => setSelected(p.id)}>
                        {p.name}
                      </button>
                    </TableCell>
                    <TableCell className="capitalize">{p.kind}</TableCell>
                    <TableCell>{pct(p.terms.revenueShareBps)}</TableCell>
                    <TableCell>{p.terms.refundWindowDays} days</TableCell>
                    <TableCell className="font-mono text-xs">{p.referralCode ?? "—"}</TableCell>
                    <TableCell><Badge variant={STATUS_TONE[p.status]}>{p.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selected !== null && <PartnerDetail id={selected} canManage={canManage} onChanged={() => list.mutate()} />}
    </div>
  )
}

function CreatePartnerForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [kind, setKind] = useState("referral")
  const [pending, setPending] = useState(false)

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const num = (k: string) => (f.get(k) === "" ? null : Number(f.get(k)))
    setPending(true)
    try {
      const { partner } = await call("/api/platform/partners", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          name: f.get("name"),
          kind,
          contactEmail: f.get("contactEmail") || null,
          terms: {
            revenueShareBps: Math.round(Number(f.get("sharePct")) * 100),
            refundWindowDays: Number(f.get("refundWindowDays")),
            contractStart: f.get("contractStart"),
            contractEnd: f.get("contractEnd") || null,
            eligibilityMonths: num("eligibilityMonths"),
          },
        }),
      })
      toast.success(`Partner ${partner.name} created`)
      form.reset()
      onCreated(partner.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create partner")
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New partner</CardTitle>
        <CardDescription>Contract terms apply to invoices issued inside the contract and eligibility windows.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="p-name">Organization name</Label>
            <Input id="p-name" name="name" required maxLength={160} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="p-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="referral">Referral</SelectItem>
                <SelectItem value="reseller">Reseller</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-email">Contact email</Label>
            <Input id="p-email" name="contactEmail" type="email" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-share">Revenue share (%)</Label>
            <Input id="p-share" name="sharePct" type="number" min={0} max={50} step={0.01} required defaultValue={10} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-refund">Refund window (days)</Label>
            <Input id="p-refund" name="refundWindowDays" type="number" min={0} max={365} required defaultValue={30} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-start">Contract start</Label>
            <Input id="p-start" name="contractStart" type="date" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-end">Contract end (optional)</Label>
            <Input id="p-end" name="contractEnd" type="date" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-elig">Eligibility months (optional)</Label>
            <Input id="p-elig" name="eligibilityMonths" type="number" min={1} max={120} />
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-3">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              Create partner
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function PartnerDetail({ id, canManage, onChanged }: { id: number; canManage: boolean; onChanged: () => void }) {
  const { data, error, mutate } = useSWR<Detail>(`/api/platform/partners/${id}`, fetcher)
  const [busy, setBusy] = useState<string | null>(null)
  const [transfer, setTransfer] = useState(false)
  const [ownership, setOwnership] = useState("platform")

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key)
    try {
      await fn()
      toast.success(ok)
      await mutate()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed")
    } finally {
      setBusy(null)
    }
  }

  if (error) return <p className="text-sm text-destructive">{error.message}</p>
  if (!data) return <p className="text-sm text-muted-foreground">Loading partner…</p>
  const { partner } = data
  const setStatus = (status: string) =>
    run(`status-${status}`, () => call(`/api/platform/partners/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }), `Partner ${status}`)

  const attribute = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const tenantId = Number(new FormData(form).get("tenantId"))
    run(
      "attribute",
      () =>
        call(`/api/platform/partners/${id}/referrals`, {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ tenantId, ownership, transfer }),
        }).then(() => form.reset()),
      "Customer attributed",
    )
  }

  const addMember = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const userId = Number(new FormData(form).get("userId"))
    run("member", () => call(`/api/platform/partners/${id}/members`, { method: "POST", body: JSON.stringify({ userId }) }).then(() => form.reset()), "Dashboard access granted")
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            {partner.name} <Badge variant={STATUS_TONE[partner.status]}>{partner.status}</Badge>
          </CardTitle>
          <CardDescription>
            {pct(partner.terms.revenueShareBps)} share · {partner.terms.refundWindowDays}-day refund window · contract{" "}
            {partner.terms.contractStart} to {partner.terms.contractEnd ?? "open-ended"}
            {partner.terms.eligibilityMonths ? ` · ${partner.terms.eligibilityMonths} months per customer` : ""}
          </CardDescription>
        </div>
        {canManage && partner.status !== "terminated" && (
          <div className="flex gap-2">
            {partner.status === "active" ? (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setStatus("suspended")}>Suspend</Button>
            ) : (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setStatus("active")}>Reactivate</Button>
            )}
            <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setStatus("terminated")}>Terminate</Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Object.entries(data.totals).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 rounded-md border p-3">
              <dt className="text-xs capitalize text-muted-foreground">{k.replace(/([A-Z])/g, " $1")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{String(v)}</dd>
            </div>
          ))}
        </dl>

        <section className="flex flex-col gap-3" aria-labelledby="refs-h">
          <h3 id="refs-h" className="font-medium">Referred customers</h3>
          {canManage && partner.status === "active" && (
            <form onSubmit={attribute} className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-tenant">Tenant ID</Label>
                <Input id="r-tenant" name="tenantId" type="number" min={1} required className="w-32" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-own">Ownership</Label>
                <Select value={ownership} onValueChange={setOwnership}>
                  <SelectTrigger id="r-own" className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="platform">Platform</SelectItem>
                    <SelectItem value="partner">Partner</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Checkbox id="r-transfer" checked={transfer} onCheckedChange={(v) => setTransfer(v === true)} />
                <Label htmlFor="r-transfer" className="font-normal">Transfer from current partner</Label>
              </div>
              <Button type="submit" size="sm" disabled={busy === "attribute"}>Attribute</Button>
            </form>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Ownership</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Attributed</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="sr-only">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.referrals.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-muted-foreground">No referrals.</TableCell></TableRow>
              )}
              {data.referrals.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.tenantName ?? `Tenant #${r.tenantId}`}</TableCell>
                  <TableCell className="capitalize">{r.ownership}</TableCell>
                  <TableCell className="capitalize">{r.source}</TableCell>
                  <TableCell>{r.attributedAt?.slice(0, 10)}{r.endedAt ? ` → ${r.endedAt.slice(0, 10)}` : ""}</TableCell>
                  <TableCell><Badge variant={STATUS_TONE[r.status] ?? "outline"}>{r.status}</Badge></TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      {r.status === "active" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() =>
                            run(`ref-${r.id}`, () => call(`/api/platform/partners/referrals/${r.id}`, {
                              method: "DELETE",
                              headers: { "Idempotency-Key": crypto.randomUUID() },
                              body: JSON.stringify({ reason: "Cancelled from platform console" }),
                            }), "Attribution cancelled")
                          }
                        >
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="mem-h">
          <h3 id="mem-h" className="font-medium">Dashboard members</h3>
          <p className="text-sm text-muted-foreground">Members see this partner&apos;s referrals and ledger only — never tenant ERP data or secrets.</p>
          {canManage && partner.status !== "terminated" && (
            <form onSubmit={addMember} className="flex items-end gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="m-user">User ID</Label>
                <Input id="m-user" name="userId" type="number" min={1} required className="w-32" />
              </div>
              <Button type="submit" size="sm" disabled={busy === "member"}>Grant access</Button>
            </form>
          )}
          <ul className="flex flex-col divide-y rounded-md border">
            {data.members.length === 0 && <li className="p-3 text-sm text-muted-foreground">No members.</li>}
            {data.members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span className="flex flex-col">
                  <span className="font-medium">{m.name ?? `User #${m.userId}`}</span>
                  <span className="text-muted-foreground">{m.email}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={STATUS_TONE[m.status] ?? "outline"}>{m.status}</Badge>
                  {canManage && m.status === "active" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => run(`mem-${m.userId}`, () => call(`/api/platform/partners/${id}/members`, { method: "DELETE", body: JSON.stringify({ userId: m.userId }) }), "Access revoked")}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <CommissionLedger commissions={data.commissions} />
      </CardContent>
    </Card>
  )
}

export function CommissionLedger({ commissions }: { commissions: Commission[] }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ledger-h">
      <h3 id="ledger-h" className="font-medium">Commission ledger</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Share</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Settled</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {commissions.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-muted-foreground">No settled commissions yet.</TableCell></TableRow>
          )}
          {commissions.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-mono text-xs">{c.invoiceNumber}</TableCell>
              <TableCell><Badge variant={c.kind === "clawback" ? "destructive" : "secondary"}>{c.kind}</Badge></TableCell>
              <TableCell>{pct(c.shareBps)}</TableCell>
              <TableCell className="text-right tabular-nums">{c.amount} {c.currency}</TableCell>
              <TableCell>{c.settledAt?.slice(0, 10) ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}
