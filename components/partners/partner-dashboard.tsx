"use client"

import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CommissionLedger } from "@/components/platform/partner-manager"

type Dashboard = {
  partner: {
    name: string
    kind: string
    referralCode: string | null
    terms: { revenueShareBps: number; refundWindowDays: number; contractStart: string; contractEnd: string | null; eligibilityMonths: number | null }
  }
  referrals: { id: number; customerName: string; ownership: string; status: string; source: string; attributedAt: string | null; endedAt: string | null }[]
  commissions: { id: number; invoiceNumber: string; kind: "commission" | "clawback"; amount: string; currency: string; shareBps: number; settledAt: string | null }[]
  totals: Record<string, string | number>
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? "Request failed")
  return body
}

export function PartnerDashboard() {
  const { data, error } = useSWR<Dashboard>("/api/partner/dashboard", fetcher)

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Partner dashboard</CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>

  const { partner, totals } = data
  const signupUrl = partner.referralCode ? `/signup?ref=${partner.referralCode}` : null

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{partner.name}</h1>
        <p className="text-sm text-muted-foreground">
          <span className="capitalize">{partner.kind}</span> partner · {(partner.terms.revenueShareBps / 100).toFixed(2)}% revenue share ·
          commissions settle {partner.terms.refundWindowDays} days after a verified payment
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Object.entries(totals).map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <dt className="text-xs capitalize text-muted-foreground">{k.replace(/([A-Z])/g, " $1")}</dt>
            <dd className="text-xl font-semibold tabular-nums">{String(v)}</dd>
          </div>
        ))}
      </dl>

      {signupUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Referral link</CardTitle>
            <CardDescription>New customers who sign up through this link are attributed to you.</CardDescription>
          </CardHeader>
          <CardContent>
            <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">{signupUrl}</code>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Customers</CardTitle>
          <CardDescription>Attribution status only. Customer ERP data and credentials are never shared.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Ownership</TableHead>
                <TableHead>Since</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.referrals.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-muted-foreground">No customers yet.</TableCell></TableRow>
              )}
              {data.referrals.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.customerName}</TableCell>
                  <TableCell className="capitalize">{r.ownership}</TableCell>
                  <TableCell>{r.attributedAt?.slice(0, 10) ?? "—"}</TableCell>
                  <TableCell><Badge variant={r.status === "active" ? "default" : "outline"}>{r.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <CommissionLedger commissions={data.commissions} />
        </CardContent>
      </Card>
    </>
  )
}
