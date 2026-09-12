"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LetterStatusBadge } from "@/components/hr/letter-status-badge"
import { LetterDetailDialog } from "@/components/hr/letter-detail-dialog"
import { ExcelExportButton } from "@/components/excel-export-button"
import { Mail, FilePlus2, Search, FileText } from "lucide-react"
import {
  LETTER_STATUSES,
  LETTER_TYPES,
  LETTER_SOURCES,
  eventByKey,
  type GeneratedLetter,
} from "@/lib/hr-letters-shared"

type LetterRow = GeneratedLetter & {
  template_name?: string | null
  created_by_name?: string | null
  event_key?: string
}

type Analytics = {
  funnel: {
    total: number
    drafts: number
    generated: number
    issued: number
    delivered: number
    cancelled: number
    deliveryRate: number
  }
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

const ALL = "__all__"

export function LettersClient() {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<string>(ALL)
  const [letterType, setLetterType] = useState<string>(ALL)
  const [source, setSource] = useState<string>(ALL)
  const [selected, setSelected] = useState<number | null>(null)

  const listUrl = useMemo(() => {
    const sp = new URLSearchParams()
    if (q.trim()) sp.set("q", q.trim())
    if (status !== ALL) sp.set("status", status)
    if (letterType !== ALL) sp.set("letter_type", letterType)
    if (source !== ALL) sp.set("source", source)
    const s = sp.toString()
    return `/api/hr/letters${s ? `?${s}` : ""}`
  }, [q, status, letterType, source])

  const { data, mutate } = useSWR<{ letters: LetterRow[] }>(listUrl, fetcher)
  const { data: analytics, mutate: mutateAnalytics } = useSWR<Analytics>("/api/hr/letters/analytics?days=365", fetcher)
  const letters = data?.letters || []
  const f = analytics?.funnel

  function refresh() {
    mutate()
    mutateAnalytics()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Mail className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Letters</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            The archive of every letter issued to employees and candidates. Open a letter to view, export a PDF, email
            it, or regenerate a fresh version.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExcelExportButton
            rows={letters}
            filename="letters"
            columns={[
              { header: "Ref", value: (r: any) => r.letter_number },
              { header: "Recipient", value: (r: any) => r.recipient_name || r.employee_name },
              { header: "Employee Code", value: (r: any) => r.employee_code },
              { header: "Type", value: (r: any) => r.letter_type },
              { header: "Category", value: (r: any) => r.category },
              { header: "Source", value: (r: any) => r.source },
              { header: "Subject", value: (r: any) => r.subject },
              { header: "Issued", value: (r: any) => r.issue_date },
              { header: "Status", value: (r: any) => r.status },
            ]}
          />
          <Link href="/modules/hr/letters/generate" className={buttonVariants()}>
            <FilePlus2 data-icon="inline-start" />
            Generate letter
          </Link>
        </div>
      </div>

      {f && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Total" value={f.total} hint="last 12 months" />
          <StatCard label="Drafts" value={f.drafts} />
          <StatCard label="Generated" value={f.generated} />
          <StatCard label="Issued" value={f.issued} />
          <StatCard label="Delivered" value={f.delivered} hint={`${f.deliveryRate}% delivery rate`} />
          <StatCard label="Cancelled" value={f.cancelled} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ref, recipient, subject…" className="pl-9" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v ?? ALL)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {LETTER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={letterType} onValueChange={(v) => setLetterType(v ?? ALL)}>
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {LETTER_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={(v) => setSource(v ?? ALL)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            {LETTER_SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Ref", "Recipient", "Type", "Event", "Issued", "Status"].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {letters.map((l) => (
              <tr
                key={l.id}
                onClick={() => setSelected(l.id)}
                className="cursor-pointer border-b transition-colors last:border-0 hover:bg-accent/50"
              >
                <td className="px-4 py-3 font-mono text-xs">{l.letter_number}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{l.recipient_name || l.employee_name || "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {[l.employee_code, l.department].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div>{l.letter_type}</div>
                  <div className="text-xs text-muted-foreground">{l.category}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{eventByKey(l.event_key).label}</td>
                <td className="px-4 py-3 whitespace-nowrap">{l.issue_date}</td>
                <td className="px-4 py-3">
                  <LetterStatusBadge status={l.status} />
                </td>
              </tr>
            ))}
            {data && letters.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <FileText className="mx-auto mb-3 size-8 text-muted-foreground/60" />
                  <p className="text-sm text-muted-foreground">
                    {q || status !== ALL || letterType !== ALL || source !== ALL
                      ? "No letters match these filters."
                      : "No letters yet. Generate your first letter to get started."}
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <LetterDetailDialog
        letterId={selected}
        onClose={() => setSelected(null)}
        onChanged={refresh}
        onSelectLetter={(id) => setSelected(id)}
      />
    </div>
  )
}
