"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PenTool, Plus, Search, Clock, CheckCircle2, FileSignature, AlertTriangle } from "lucide-react"
import {
  ESIGN_STATUSES,
  ESIGN_SOURCE_META,
  esignSourceLabel,
  type EsignRequest,
  type EsignStats,
} from "@/lib/legal-esign-shared"
import { EsignStatusBadge } from "@/components/legal/esign-status-badge"
import { CreateEsignDialog } from "@/components/legal/create-esign-dialog"
import { EsignDetailDialog } from "@/components/legal/esign-detail-dialog"
import { EsignFieldEditor } from "@/components/legal/esign-field-editor"
import { EsignSignatoriesManager } from "@/components/legal/esign-signatories-manager"

const ALL = "__all__"

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

export function EsignClient({ canManage }: { canManage: boolean }) {
  const [q, setQ] = useState("")
  const [statusFilter, setStatusFilter] = useState(ALL)
  const [sourceFilter, setSourceFilter] = useState(ALL)
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [fieldEditorReq, setFieldEditorReq] = useState<EsignRequest | null>(null)

  const listKey = useMemo(() => {
    const sp = new URLSearchParams()
    if (statusFilter !== ALL) sp.set("status", statusFilter)
    if (sourceFilter !== ALL) sp.set("source", sourceFilter)
    if (q.trim()) sp.set("search", q.trim())
    const s = sp.toString()
    return `/api/legal/esign${s ? `?${s}` : ""}`
  }, [statusFilter, sourceFilter, q])

  const { data, mutate, isLoading } = useSWR<{ requests: EsignRequest[]; total: number; stats: EsignStats }>(
    listKey,
    fetcher,
    { keepPreviousData: true },
  )

  const requests = data?.requests || []
  const stats = data?.stats

  function signerSummary(req: EsignRequest): string {
    const signers = req.signers || []
    if (signers.length === 0) return "No signers"
    const signed = signers.filter((s) => s.status === "Signed").length
    return `${signed}/${signers.length} signed`
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <PenTool className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">E-sign</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Send generated contracts for electronic signature and track every request from draft through completion.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            New signature request
          </Button>
        )}
      </div>

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="signatories">Authorized signatories</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="flex flex-col gap-6 pt-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total" value={stats?.total ?? "—"} icon={FileSignature} />
            <StatCard label="Awaiting" value={stats?.awaiting ?? "—"} icon={Clock} tone="text-amber-600" />
            <StatCard label="Completed" value={stats?.completed ?? "—"} icon={CheckCircle2} tone="text-emerald-600" />
            <StatCard
              label="Rejected / expired"
              value={stats ? stats.rejected + stats.expired : "—"}
              icon={AlertTriangle}
              tone="text-rose-600"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search requests…" className="pl-9" />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {ESIGN_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="All sources" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All sources</SelectItem>
                {Object.entries(ESIGN_SOURCE_META).map(([key, meta]) => (
                  <SelectItem key={key} value={key}>
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {["Reference", "Document", "Source", "Signers", "Due", "Status"].map((x) => (
                    <th key={x} className="px-4 py-3 font-medium">
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                    onClick={() => setDetailId(r.id)}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.request_uid}</td>
                    <td className="px-4 py-3 font-medium">
                      {r.title}
                      {r.contract_reference ? (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">· {r.contract_reference}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{esignSourceLabel(r.document_source)}</td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">{signerSummary(r)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.due_date)}</td>
                    <td className="px-4 py-3">
                      <EsignStatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
                {!isLoading && requests.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      {canManage
                        ? "No signature requests yet. Create one from a generated contract to get started."
                        : "No signature requests yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="signatories" className="pt-4">
          <EsignSignatoriesManager canManage={canManage} />
        </TabsContent>
      </Tabs>

      {createOpen && (
        <CreateEsignDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(request, prepare) => {
            setCreateOpen(false)
            mutate()
            if (prepare) setFieldEditorReq(request)
            else setDetailId(request.id)
          }}
        />
      )}

      {detailId !== null && (
        <EsignDetailDialog
          requestId={detailId}
          canManage={canManage}
          onClose={() => setDetailId(null)}
          onChanged={() => mutate()}
          onPrepareFields={(req) => {
            setDetailId(null)
            setFieldEditorReq(req)
          }}
        />
      )}

      {fieldEditorReq && (
        <EsignFieldEditor
          request={fieldEditorReq}
          onClose={() => setFieldEditorReq(null)}
          onSaved={(updated) => {
            setFieldEditorReq(null)
            mutate()
            setDetailId(updated.id)
          }}
        />
      )}
    </div>
  )
}
