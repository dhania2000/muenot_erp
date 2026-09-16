"use client"

import { useState } from "react"
import useSWR, { mutate as globalMutate } from "swr"
import { fetcher } from "@/lib/fetcher"
import { inr, inr0 } from "@/lib/finance-calc"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import type { BadgeVariant } from "@/lib/finance-schema"
import {
  ArrowLeft, Loader2Icon, Landmark, Coins, Clock, CalendarDays, FileText,
  BookOpen, Wallet, TrendingUp, ExternalLink, Plus, Scale, LogOut, PiggyBank,
} from "lucide-react"

type Row = Record<string, any>
type InvestmentDetail = {
  investment: Row
  transactions: Row[]
  stats: {
    purchaseValue: number
    investedAmount: number
    currentValue: number
    unrealisedGain: number
    realisedGain: number
    incomeReceived: number
    quantity: number
    totalReturn: number
  }
}

const STATUS_BADGE: Record<string, BadgeVariant> = {
  Active: "default", Matured: "secondary", Sold: "outline", Redeemed: "outline",
  Closed: "outline", Impaired: "destructive",
}
const TXN_BADGE: Record<string, BadgeVariant> = {
  Purchase: "default", "Additional Investment": "default", Interest: "secondary",
  Dividend: "secondary", "Valuation Adjustment": "outline", Sale: "outline",
  Redemption: "outline", Maturity: "outline",
}
const CASH_MODES = ["Bank", "Cash"]
const FUNDING_SOURCES = ["Bank", "Cash", "Accounts Payable", "Owner Capital"]
const CLOSED_STATUSES = new Set(["Matured", "Sold", "Redeemed", "Closed"])

function fmtDate(v: any) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}
const today = () => new Date().toISOString().slice(0, 10)

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="w-fit" render={<a href="/modules/finance/investments" />}>
      <ArrowLeft data-icon="inline-start" />
      Back to Investments
    </Button>
  )
}

/** Which input fields each lifecycle action needs. */
type ActionKey = "add" | "interest" | "dividend" | "revalue" | "sale" | "redemption" | "maturity"

type ActionDef = {
  key: ActionKey
  label: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  variant?: "default" | "outline" | "secondary"
}

const ACTIONS: ActionDef[] = [
  { key: "add", label: "Add investment", title: "Additional investment", description: "Top up this holding. Posts Dr Investment / Cr funding source.", icon: Plus },
  { key: "interest", label: "Record interest", title: "Interest income", description: "Interest received. Posts Dr Bank/Cash / Cr Investment Income.", icon: PiggyBank, variant: "outline" },
  { key: "dividend", label: "Record dividend", title: "Dividend income", description: "Dividend received. Posts Dr Bank/Cash / Cr Investment Income.", icon: Coins, variant: "outline" },
  { key: "revalue", label: "Revalue", title: "Valuation adjustment", description: "Mark the holding to its fair value. Posts the gain or impairment.", icon: Scale, variant: "outline" },
  { key: "sale", label: "Sell", title: "Sale", description: "Dispose the holding by sale. Books proceeds and realised gain/loss.", icon: LogOut, variant: "secondary" },
  { key: "redemption", label: "Redeem", title: "Redemption", description: "Redeem the holding. Books proceeds and realised gain/loss.", icon: LogOut, variant: "secondary" },
  { key: "maturity", label: "Mature", title: "Maturity", description: "Close the holding at maturity. Books proceeds and realised gain/loss.", icon: LogOut, variant: "secondary" },
]

export function InvestmentDetailClient({ investmentId }: { investmentId: string }) {
  const apiUrl = `/api/finance/investments/${encodeURIComponent(investmentId)}`
  const { data, error, isLoading, mutate } = useSWR<InvestmentDetail>(apiUrl, fetcher)

  const [active, setActive] = useState<ActionDef | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function openAction(def: ActionDef) {
    setFormError(null)
    setForm({ date: today(), mode: "Bank", fundingSource: data?.investment?.funding_source || "Bank", kind: "" })
    setActive(def)
  }
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  async function submit() {
    if (!active) return
    setSubmitting(true)
    setFormError(null)

    let payload: Record<string, any>
    if (active.key === "add") {
      payload = { action: "add", amount: form.amount, quantity: form.quantity, date: form.date, fundingSource: form.fundingSource, notes: form.notes }
    } else if (active.key === "interest" || active.key === "dividend") {
      payload = { action: "income", kind: active.key === "dividend" ? "Dividend" : "Interest", amount: form.amount, date: form.date, mode: form.mode, notes: form.notes }
    } else if (active.key === "revalue") {
      payload = { action: "revalue", newValue: form.newValue, date: form.date, notes: form.notes }
    } else {
      const kind = active.key === "redemption" ? "Redemption" : active.key === "maturity" ? "Maturity" : "Sale"
      payload = { action: "dispose", kind, proceeds: form.proceeds, costPortion: form.costPortion, quantity: form.quantity, date: form.date, mode: form.mode, notes: form.notes }
    }

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(json.error || "Action failed")
        setSubmitting(false)
        return
      }
      setActive(null)
      await mutate()
      // Refresh the list view KPIs/rows the next time it mounts.
      globalMutate((key) => typeof key === "string" && key.startsWith("/api/finance/investments"), undefined, { revalidate: true })
    } catch {
      setFormError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </main>
    )
  }
  if (error || !data?.investment) {
    return (
      <main className="space-y-4 p-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertDescription>This investment could not be loaded. It may have been deleted.</AlertDescription>
        </Alert>
      </main>
    )
  }

  const { investment: x, transactions, stats } = data
  const status = String(x.status || "Active")
  const postingStatus = String(x.posting_status || "")
  const isClosed = CLOSED_STATUSES.has(status)
  const gainPositive = stats.unrealisedGain >= 0

  const kpis: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; hint?: string }[] = [
    { label: "Invested", value: inr0(stats.investedAmount), icon: Landmark },
    { label: "Current value", value: inr0(stats.currentValue), icon: TrendingUp, hint: `${gainPositive ? "+" : ""}${inr(stats.unrealisedGain)} unrealised` },
    { label: "Income received", value: inr0(stats.incomeReceived), icon: PiggyBank },
    { label: "Total return", value: inr0(stats.totalReturn), icon: Coins, hint: `${inr(stats.realisedGain)} realised` },
  ]

  const terms: { label: string; value: React.ReactNode }[] = [
    { label: "Type", value: x.investment_type || "—" },
    { label: "Institution", value: x.institution || "—" },
    { label: "Purchase value", value: inr(stats.purchaseValue) },
    { label: "Quantity / units", value: Number(x.units) ? Number(x.units).toLocaleString("en-IN") : "—" },
    { label: "Interest rate", value: Number(x.expected_return_rate) ? `${Number(x.expected_return_rate)}%` : "—" },
    { label: "Purchase date", value: fmtDate(x.acquisition_date) },
    { label: "Maturity date", value: fmtDate(x.maturity_date) },
    { label: "Financial year", value: x.financial_year || "—" },
    { label: "Funded via", value: x.funding_source || "—" },
    { label: "COA account", value: x.coa_account_name || x.coa_account || "Default control head" },
  ]
  if (isClosed) {
    terms.push({ label: "Closed on", value: fmtDate(x.closed_date) })
    terms.push({ label: "Closed value", value: inr(x.closed_value) })
  }

  return (
    <main className="space-y-6 p-6">
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{x.investment_name || x.investment_id}</h1>
            <Badge variant={STATUS_BADGE[status] || "outline"}>{status}</Badge>
            {x.investment_type && <Badge variant="outline">{x.investment_type}</Badge>}
          </div>
          <p className="font-mono text-sm text-muted-foreground">{x.investment_id}</p>
        </div>
        {x.documents && (
          <Button variant="outline" size="sm" render={<a href={x.documents} target="_blank" rel="noopener noreferrer" />}>
            <FileText data-icon="inline-start" />
            Documents
            <ExternalLink data-icon="inline-end" />
          </Button>
        )}
      </div>

      {/* Lifecycle actions */}
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <Button key={a.key} variant={a.variant || "default"} size="sm" onClick={() => openAction(a)} disabled={isClosed}>
            <a.icon data-icon="inline-start" />
            {a.label}
          </Button>
        ))}
      </div>
      {isClosed && (
        <Alert>
          <AlertDescription>
            This holding is <span className="font-medium">{status}</span>. No further lifecycle transactions can be posted.
          </AlertDescription>
        </Alert>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-xl font-semibold tracking-tight">{k.value}</span>
              {k.hint && <span className="text-xs text-muted-foreground">{k.hint}</span>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Holding details */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 text-muted-foreground" />
            Holding details
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          {terms.map((t) => (
            <div key={t.label} className="space-y-1">
              <dt className="text-xs text-muted-foreground">{t.label}</dt>
              <dd className="text-sm font-medium">{t.value}</dd>
            </div>
          ))}
          {(postingStatus || x.voucher_no) && (
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Accounting</dt>
              <dd className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {postingStatus && (
                  <Badge variant={postingStatus.toLowerCase() === "posted" ? "default" : "outline"}>
                    <BookOpen data-icon="inline-start" />
                    {postingStatus}
                  </Badge>
                )}
                {x.voucher_no && <span className="font-mono text-xs text-muted-foreground">{x.voucher_no}</span>}
              </dd>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transaction history */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" />
              Transaction history
            </span>
            <Badge variant="secondary">{transactions.length} entries</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              Only the initial purchase has been posted. Use the actions above to record income, revaluations or a disposal.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2 font-medium">Date</th>
                    <th className="p-2 font-medium">Type</th>
                    <th className="p-2 text-right font-medium">Amount</th>
                    <th className="p-2 text-right font-medium">Income</th>
                    <th className="p-2 text-right font-medium">Gain / loss</th>
                    <th className="p-2 text-right font-medium">Proceeds</th>
                    <th className="p-2 font-medium">Voucher</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id} className="border-b hover:bg-muted/40">
                      <td className="p-2">{fmtDate(t.txn_date)}</td>
                      <td className="p-2">
                        <Badge variant={TXN_BADGE[t.txn_type] || "outline"}>{t.txn_type}</Badge>
                      </td>
                      <td className="p-2 text-right">{Number(t.amount) ? inr(t.amount) : "—"}</td>
                      <td className="p-2 text-right">{Number(t.income_amount) ? inr(t.income_amount) : "—"}</td>
                      <td className="p-2 text-right">{Number(t.gain_amount) ? inr(t.gain_amount) : "—"}</td>
                      <td className="p-2 text-right">{Number(t.proceeds) ? inr(t.proceeds) : "—"}</td>
                      <td className="p-2 font-mono text-xs text-muted-foreground">{t.voucher_no || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {x.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{x.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Action dialog */}
      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="sm:max-w-md">
          {active && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <active.icon className="size-4 text-muted-foreground" />
                  {active.title}
                </DialogTitle>
                <DialogDescription>{active.description}</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-2">
                {active.key === "add" && (
                  <>
                    <Field label="Amount" required>
                      <Input type="number" inputMode="decimal" value={form.amount || ""} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
                    </Field>
                    <Field label="Quantity / units">
                      <Input type="number" inputMode="decimal" value={form.quantity || ""} onChange={(e) => set("quantity", e.target.value)} placeholder="0" />
                    </Field>
                    <SelectField label="Funded via" value={form.fundingSource} onChange={(v) => set("fundingSource", v)} options={FUNDING_SOURCES} />
                  </>
                )}

                {(active.key === "interest" || active.key === "dividend") && (
                  <>
                    <Field label="Amount" required>
                      <Input type="number" inputMode="decimal" value={form.amount || ""} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
                    </Field>
                    <SelectField label="Received in" value={form.mode} onChange={(v) => set("mode", v)} options={CASH_MODES} />
                  </>
                )}

                {active.key === "revalue" && (
                  <Field label="New current value" required>
                    <Input type="number" inputMode="decimal" value={form.newValue || ""} onChange={(e) => set("newValue", e.target.value)} placeholder={String(stats.currentValue)} />
                  </Field>
                )}

                {(active.key === "sale" || active.key === "redemption" || active.key === "maturity") && (
                  <>
                    <Field label="Proceeds" required>
                      <Input type="number" inputMode="decimal" value={form.proceeds || ""} onChange={(e) => set("proceeds", e.target.value)} placeholder="0.00" />
                    </Field>
                    <Field label="Cost portion" hint={`Leave blank for full disposal (invested ${inr(stats.investedAmount)})`}>
                      <Input type="number" inputMode="decimal" value={form.costPortion || ""} onChange={(e) => set("costPortion", e.target.value)} placeholder={String(stats.investedAmount)} />
                    </Field>
                    <Field label="Quantity disposed">
                      <Input type="number" inputMode="decimal" value={form.quantity || ""} onChange={(e) => set("quantity", e.target.value)} placeholder="Auto" />
                    </Field>
                    <SelectField label="Received in" value={form.mode} onChange={(v) => set("mode", v)} options={CASH_MODES} />
                  </>
                )}

                <Field label="Date">
                  <Input type="date" value={form.date || ""} onChange={(e) => set("date", e.target.value)} />
                </Field>
                <Field label="Notes">
                  <Textarea rows={2} value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} placeholder="Optional" />
                </Field>

                {formError && (
                  <Alert variant="destructive">
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setActive(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button onClick={submit} disabled={submitting}>
                  {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                  Post {active.title.toLowerCase()}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

function SelectField({ label, value, onChange, options }: { label: string; value?: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
