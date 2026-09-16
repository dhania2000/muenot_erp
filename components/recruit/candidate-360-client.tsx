"use client"

import useSWR, { mutate } from "swr"
import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import {
  Users, Search, RefreshCw, Link2, ClipboardList, CalendarClock, MessageSquare,
  FileCheck, ShieldCheck, LogIn, UserCheck, FileText, Loader2, ExternalLink,
} from "lucide-react"
import { toast } from "sonner"

type Stage =
  | "requisition" | "applied" | "screening" | "interview" | "feedback"
  | "selection" | "offer" | "verification" | "pre_joining" | "hired"

type FunnelRow = { stage: Stage; label: string; count: number }
type UnifiedCandidate = {
  candidate_id: string
  candidate_name: string
  email: string | null
  mobile: string | null
  job_applied: string | null
  application_id: string | null
  stage: Stage
  stage_label: string
  hired_employee_id: string | null
  last_activity: string | null
  counts: {
    applications: number
    screenings: number
    interviews: number
    feedback: number
    offers: number
    verifications: number
  }
}
type ListResponse = { candidates: UnifiedCandidate[]; funnel: FunnelRow[]; total: number }

const STAGE_STYLES: Record<Stage, string> = {
  requisition: "bg-slate-100 text-slate-700 border-slate-200",
  applied: "bg-blue-100 text-blue-700 border-blue-200",
  screening: "bg-cyan-100 text-cyan-700 border-cyan-200",
  interview: "bg-violet-100 text-violet-700 border-violet-200",
  feedback: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200",
  selection: "bg-amber-100 text-amber-700 border-amber-200",
  offer: "bg-orange-100 text-orange-700 border-orange-200",
  verification: "bg-teal-100 text-teal-700 border-teal-200",
  pre_joining: "bg-indigo-100 text-indigo-700 border-indigo-200",
  hired: "bg-emerald-100 text-emerald-700 border-emerald-200",
}

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  requisition: ClipboardList,
  applied: FileText,
  screening: Search,
  interview: CalendarClock,
  feedback: MessageSquare,
  selection: UserCheck,
  offer: FileCheck,
  verification: ShieldCheck,
  pre_joining: LogIn,
  hired: UserCheck,
}

function fmtDate(v: string | null | undefined) {
  if (!v) return "—"
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function StageBadge({ stage, label }: { stage: Stage; label: string }) {
  return (
    <Badge variant="outline" className={STAGE_STYLES[stage] || ""}>
      {label}
    </Badge>
  )
}

export function Candidate360Client({ canManage }: { canManage: boolean }) {
  const searchParams = useSearchParams()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)

  // Deep-link: open a candidate directly when arriving with ?id= (e.g. from the
  // Candidate Database). The detail sheet fetches by id, so it works even when
  // the candidate isn't in the current (unsearched) list.
  useEffect(() => {
    const id = searchParams.get("id")
    if (id) setSelected(id)
  }, [searchParams])

  const key = `/api/recruit/candidate-360${search ? `?search=${encodeURIComponent(search)}` : ""}`
  const { data, isLoading } = useSWR<ListResponse>(key, fetcher)

  const funnel = data?.funnel || []
  const candidates = data?.candidates || []

  async function runBackfill() {
    setBackfilling(true)
    try {
      const res = await fetch("/api/recruit/candidate-360/backfill", { method: "POST" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Backfill failed")
      toast.success(
        `Linked ${body.applicationsLinked} applications and ${body.stageRowsLinked} stage records into the unified spine.`,
      )
      mutate(key)
    } catch (err: any) {
      toast.error(err.message || "Backfill failed")
    } finally {
      setBackfilling(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Users className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Candidate 360</h1>
              <p className="text-sm text-muted-foreground">
                One unified pipeline across the operational and module systems.
              </p>
            </div>
          </div>
          {canManage && (
            <Button variant="outline" size="sm" onClick={runBackfill} disabled={backfilling}>
              {backfilling ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
              Link existing records
            </Button>
          )}
        </div>
      </header>

      {/* Unified funnel */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {funnel.map((f) => {
          const Icon = STAGE_ICONS[f.stage] || FileText
          return (
            <Card key={f.stage} className="border shadow-none">
              <CardContent className="flex items-center gap-3 p-3">
                <div className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-lg font-semibold leading-none">{f.count}</div>
                  <div className="truncate text-xs text-muted-foreground">{f.label}</div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, phone, ID, role…"
          className="pl-8"
        />
      </div>

      {/* Candidate list */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Candidate</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="text-center">Interviews</TableHead>
                <TableHead className="text-center">Checks</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    <Loader2 className="mx-auto size-5 animate-spin" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No candidates found.
                  </TableCell>
                </TableRow>
              )}
              {candidates.map((c) => (
                <TableRow
                  key={c.candidate_id}
                  className="cursor-pointer"
                  onClick={() => setSelected(c.candidate_id)}
                >
                  <TableCell>
                    <div className="font-medium">{c.candidate_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.email || c.mobile || c.candidate_id}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{c.job_applied || "—"}</TableCell>
                  <TableCell><StageBadge stage={c.stage} label={c.stage_label} /></TableCell>
                  <TableCell className="text-center text-sm tabular-nums">{c.counts.interviews}</TableCell>
                  <TableCell className="text-center text-sm tabular-nums">{c.counts.verifications}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmtDate(c.last_activity)}</TableCell>
                  <TableCell>
                    <ExternalLink className="size-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <CandidateDetail id={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

type TimelineEvent = {
  stage: Stage
  type: string
  title: string
  subtitle?: string | null
  status?: string | null
  date: string | null
  source: "operational" | "module"
  ref_id?: string | null
}
type Detail = {
  candidate: any | null
  applications: any[]
  requisitions: any[]
  screenings: any[]
  interviews: any[]
  feedback: any[]
  assessments: any[]
  selections: any[]
  offers: any[]
  verifications: any[]
  references: any[]
  preJoining: any[]
  employee: any | null
  timeline: TimelineEvent[]
  stage: Stage
  stage_label: string
}

function CandidateDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = useSWR<Detail>(
    id ? `/api/recruit/candidate-360/${encodeURIComponent(id)}` : null,
    fetcher,
  )
  const c = data?.candidate

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {c?.candidate_name || "Candidate"}
            {data && <StageBadge stage={data.stage} label={data.stage_label} />}
          </SheetTitle>
          <SheetDescription>
            {c?.candidate_id}
            {c?.email ? ` · ${c.email}` : ""}
            {c?.mobile ? ` · ${c.mobile}` : ""}
          </SheetDescription>
        </SheetHeader>

        {isLoading && (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && (
          <div className="mt-4 flex flex-col gap-6">
            {/* Key facts */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Fact label="Role" value={c?.job_applied} />
              <Fact label="Source" value={c?.source} />
              <Fact label="Applications" value={String(data.applications.length)} />
              <Fact label="Application ID" value={data.applications[0]?.application_id || c?.application_id} />
              {data.employee && <Fact label="Employee ID" value={data.employee.employee_id} />}
              {data.employee && <Fact label="Joined" value={fmtDate(data.employee.joining_date)} />}
            </div>

            <Separator />

            {/* Timeline */}
            <div>
              <h3 className="mb-3 text-sm font-semibold">Journey timeline</h3>
              {data.timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
              ) : (
                <ol className="relative flex flex-col gap-4 border-l pl-5">
                  {data.timeline.map((e, i) => {
                    const Icon = STAGE_ICONS[e.stage] || FileText
                    return (
                      <li key={`${e.type}-${e.ref_id}-${i}`} className="relative">
                        <span className="absolute -left-[27px] flex size-5 items-center justify-center rounded-full border bg-background">
                          <Icon className="size-3 text-muted-foreground" />
                        </span>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{e.title}</div>
                            {e.subtitle && (
                              <div className="truncate text-xs text-muted-foreground">{e.subtitle}</div>
                            )}
                            <div className="mt-1 flex items-center gap-2">
                              {e.status && (
                                <Badge variant="secondary" className="text-[10px]">{e.status}</Badge>
                              )}
                              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {e.source}
                              </span>
                            </div>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(e.date)}</span>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value || "—"}</div>
    </div>
  )
}
