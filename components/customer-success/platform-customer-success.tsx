"use client"

import { useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { BandBadge, HealthDetail } from "@/components/customer-success/health-detail"
import type { TenantHealthDetail, TenantHealthRow } from "@/lib/customer-success/store"

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? "Request failed")
  return body
}

export function PlatformCustomerSuccess() {
  const [q, setQ] = useState("")
  const [band, setBand] = useState("")
  const [risk, setRisk] = useState(false)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const params = new URLSearchParams({ page: String(page), pageSize: "25" })
  if (q.trim()) params.set("q", q.trim())
  if (band) params.set("band", band)
  if (risk) params.set("risk", "1")
  const list = useSWR<{ rows: TenantHealthRow[]; total: number }>(`/api/platform/customer-success?${params}`, fetcher)
  const detail = useSWR<TenantHealthDetail>(selected ? `/api/platform/customer-success/${selected}` : null, fetcher)

  async function recompute() {
    if (!selected) return
    setBusy(true)
    try {
      await fetch(`/api/platform/customer-success/${selected}`, { method: "POST" })
      await Promise.all([detail.mutate(), list.mutate()])
    } finally {
      setBusy(false)
    }
  }

  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25))

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-balance">Customer success</h1>
        <p className="text-sm text-muted-foreground text-pretty">
          Tenant health from adoption, errors, jobs, billing and support. Lowest scores first.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tenants</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setPage(1) }}>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Search
              <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Tenant name" className="w-56" maxLength={100} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Band
              <select value={band} onChange={(e) => { setBand(e.target.value); setPage(1) }} className="h-9 rounded-md border bg-background px-2 text-sm">
                <option value="">All</option>
                <option value="healthy">Healthy</option>
                <option value="watch">Watch</option>
                <option value="at_risk">At risk</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={risk} onChange={(e) => { setRisk(e.target.checked); setPage(1) }} />
              With churn risks only
            </label>
          </form>

          {list.error ? (
            <p className="text-sm text-destructive" role="alert">{list.error.message}</p>
          ) : !list.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : list.data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tenants match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Tenant</th>
                    <th className="py-2 font-medium">Plan</th>
                    <th className="py-2 text-right font-medium">Score</th>
                    <th className="py-2 font-medium">Band</th>
                    <th className="py-2 text-right font-medium">Risks</th>
                    <th className="py-2 font-medium">Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows.map((r) => (
                    <tr key={r.tenantId} className={`border-t ${selected === r.tenantId ? "bg-muted" : ""}`}>
                      <td className="py-2">
                        <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={() => setSelected(r.tenantId)}>
                          {r.name}
                        </button>
                      </td>
                      <td className="py-2 text-muted-foreground">{r.plan}</td>
                      <td className="py-2 text-right tabular-nums">{r.score ?? "—"}</td>
                      <td className="py-2"><BandBadge band={r.band} /></td>
                      <td className="py-2 text-right tabular-nums">{r.riskCount}</td>
                      <td className="py-2 text-muted-foreground">{r.snapshotDate ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{list.data?.total ?? 0} tenants</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selected && (
        <section className="flex flex-col gap-3" aria-label="Tenant health detail">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Tenant #{selected}</h2>
            <Button size="sm" onClick={recompute} disabled={busy}>{busy ? "Recomputing…" : "Recompute today"}</Button>
          </div>
          {detail.error ? (
            <p className="text-sm text-destructive" role="alert">{detail.error.message}</p>
          ) : detail.data ? (
            <HealthDetail data={detail.data} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </section>
      )}
    </div>
  )
}
