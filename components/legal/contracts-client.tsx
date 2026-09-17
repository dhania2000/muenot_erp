"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ScrollText,
  Plus,
  Search,
  Download,
  FileSignature,
  Clock,
  CheckCircle2,
} from "lucide-react"
import {
  CONTRACT_STATUSES,
  CONTRACT_SOURCE_META,
  sourceMeta,
  type GeneratedContract,
} from "@/lib/legal-contracts-shared"
import { ContractStatusBadge } from "@/components/legal/contract-status-badge"
import { GenerateContractDialog } from "@/components/legal/generate-contract-dialog"
import { ContractDetailDialog } from "@/components/legal/contract-detail-dialog"

const ALL = "__all__"

type Stats = { total: number; active: number; pending: number; expiringSoon: number }

function fmtDate(d: string | null | undefined) {
  if (!d) return "—"
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone = "text-primary",
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ className?: string }>
  tone?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
      <span className={`inline-flex size-10 items-center justify-center rounded-lg bg-muted ${tone}`}>
        <Icon className="size-5" />
      </span>
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </div>
    </div>
  )
}

export function ContractsClient() {
  const [q, setQ] = useState("")
  const [statusFilter, setStatusFilter] = useState(ALL)
  const [sourceFilter, setSourceFilter] = useState(ALL)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  const listKey = useMemo(() => {
    const sp = new URLSearchParams()
    if (statusFilter !== ALL) sp.set("status", statusFilter)
    if (sourceFilter !== ALL) sp.set("source", sourceFilter)
    if (q.trim()) sp.set("search", q.trim())
    const s = sp.toString()
    return `/api/legal/contracts${s ? `?${s}` : ""}`
  }, [statusFilter, sourceFilter, q])

  const { data, mutate, isLoading } = useSWR<{ contracts: GeneratedContract[]; total: number; stats: Stats }>(
    listKey,
    fetcher,
    { keepPreviousData: true },
  )

  const contracts = data?.contracts || []
  const stats = data?.stats

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <ScrollText className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Contracts</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Generate agreements from templates and live company records, then track them from draft through signature.
          </p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Plus data-icon="inline-start" />
          Generate contract
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total" value={stats?.total ?? "—"} icon={ScrollText} />
        <StatCard label="Active" value={stats?.active ?? "—"} icon={CheckCircle2} tone="text-emerald-600" />
        <StatCard label="Pending" value={stats?.pending ?? "—"} icon={Clock} tone="text-amber-600" />
        <StatCard label="Expiring soon" value={stats?.expiringSoon ?? "—"} icon={FileSignature} tone="text-blue-600" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contracts…" className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {CONTRACT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="All sources" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            {CONTRACT_SOURCE_META.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Reference", "Title", "Type", "Counterparty", "Status", "Effective", "End", ""].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.id} className="cursor-pointer border-b last:border-0 hover:bg-muted/40" onClick={() => setDetailId(c.id)}>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.reference_no || c.contract_uid}</td>
                <td className="px-4 py-3 font-medium">{c.title}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.contract_type}</td>
                <td className="px-4 py-3">{c.party_name || <span className="text-muted-foreground">{sourceMeta(c.source).partyRole}</span>}</td>
                <td className="px-4 py-3"><ContractStatusBadge status={c.status} /></td>
                <td className="px-4 py-3 text-muted-foreground">{fmtDate(c.effective_date)}</td>
                <td className="px-4 py-3 text-muted-foreground">{fmtDate(c.end_date)}</td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Download PDF"
                      render={<a href={`/api/legal/contracts/${c.id}/pdf?download=1`} />}
                    >
                      <Download className="size-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!isLoading && contracts.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  No contracts yet. Generate one from a published template to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {generateOpen && (
        <GenerateContractDialog
          onClose={() => setGenerateOpen(false)}
          onGenerated={(id) => {
            setGenerateOpen(false)
            mutate()
            setDetailId(id)
          }}
        />
      )}
      {detailId !== null && <ContractDetailDialog contractId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}
