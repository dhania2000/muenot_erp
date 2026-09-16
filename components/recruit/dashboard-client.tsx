"use client"

import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertTriangle,
  Briefcase,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Clock,
  ExternalLink,
  Filter,
  FileText,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Plus,
  ShieldCheck,
  UserCheck,
  Users,
} from "lucide-react"
import { PageHeader, StageBadge, StatusPill } from "@/components/recruit/recruit-shared"
import { formatDate, formatDateTime, labelFor, INTERVIEW_MODES } from "@/lib/recruit"

type Pipeline = {
  openJobs: number
  openRequisitions: number
  applications: number
  screening: number
  shortlisted: number
  assessments: number
  interviews: number
  selected: number
  offers: number
  acceptedOffers: number
  upcomingJoining: number
  joined: number
  pendingBgv: number
  pendingReference: number
  pendingFeedback: number
  dueFollowups: number
}

type Stats = {
  jobs: { total: number; open: number; positions: number }
  applications: { total: number; byStage: Record<string, number> }
  interviews: { total: number; upcoming: number }
  offers: { total: number; accepted: number }
  pipeline?: Pipeline
  funnel?: { key: string; label: string; count: number }[]
  recentApplications: { application_id: string; candidate_name: string; job_title: string | null; stage: string; applied_at: string }[]
  upcomingInterviews: { interview_id: string; candidate_name: string | null; job_title: string | null; scheduled_at: string | null; mode: string | null; status: string }[]
  stale: {
    thresholds: { applicationDays: number; requisitionGraceDays: number; jobDays: number }
    applications: { total: number; items: { application_id: string; candidate_name: string | null; job_title: string | null; stage: string; days_in_stage: number }[] }
    requisitions: { total: number; items: { requisition_id: string; job_title: string | null; target_date: string | null; days_open: number; required: number; filled: number; pending: number }[] }
    jobs: { total: number; items: { job_id: string; title: string; days_since_activity: number }[] }
  } | null
}

export function DashboardClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading } = useSWR<Stats>("/api/recruit/dashboard", fetcher)

  const p = data?.pipeline
  const stats: { label: string; value: number; icon: typeof Briefcase; href: string }[] = [
    { label: "Open jobs", value: p?.openJobs ?? data?.jobs.open ?? 0, icon: Briefcase, href: "/modules/recruitment/jobs" },
    { label: "Open requisitions", value: p?.openRequisitions ?? 0, icon: ClipboardList, href: "/modules/recruitment/requisition-hiring" },
    { label: "Applications", value: p?.applications ?? data?.applications.total ?? 0, icon: Users, href: "/modules/recruitment/job-applications" },
    { label: "Screening", value: p?.screening ?? 0, icon: Filter, href: "/modules/recruitment/job-applications" },
    { label: "Shortlisted", value: p?.shortlisted ?? 0, icon: ListChecks, href: "/modules/recruitment/job-applications" },
    { label: "Assessments", value: p?.assessments ?? 0, icon: ClipboardCheck, href: "/modules/recruitment/job-applications" },
    { label: "Interviews", value: p?.interviews ?? data?.interviews.total ?? 0, icon: CalendarClock, href: "/modules/recruitment/interview-schedule" },
    { label: "Selected", value: p?.selected ?? 0, icon: UserCheck, href: "/modules/recruitment/job-applications" },
    { label: "Offers", value: p?.offers ?? data?.offers.total ?? 0, icon: FileText, href: "/modules/recruitment/job-offer-letter" },
    { label: "Accepted offers", value: p?.acceptedOffers ?? data?.offers.accepted ?? 0, icon: FileText, href: "/modules/recruitment/job-offer-letter" },
    { label: "Upcoming joining", value: p?.upcomingJoining ?? 0, icon: CalendarClock, href: "/modules/recruitment/onboarding" },
    { label: "Joined", value: p?.joined ?? 0, icon: UserCheck, href: "/modules/recruitment/onboarding" },
    { label: "Pending BGV", value: p?.pendingBgv ?? 0, icon: ShieldCheck, href: "/modules/recruitment/onboarding" },
    { label: "Pending reference", value: p?.pendingReference ?? 0, icon: ShieldCheck, href: "/modules/recruitment/onboarding" },
    { label: "Pending feedback", value: p?.pendingFeedback ?? 0, icon: MessageSquare, href: "/modules/recruitment/interview-schedule" },
    { label: "Due follow-ups", value: p?.dueFollowups ?? 0, icon: Clock, href: "/modules/recruitment/job-applications" },
  ]

  const funnel = data?.funnel ?? []
  const funnelMax = funnel.reduce((m, s) => Math.max(m, s.count), 0)

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Recruit Dashboard"
        description="Hiring pipeline at a glance — jobs, applications, interviews and offers."
        icon={LayoutDashboard}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" render={<Link href="/careers" target="_blank" />}>
              <ExternalLink data-icon="inline-start" /> Careers site
            </Button>
            {canManage && (
              <Button size="sm" render={<Link href="/modules/recruitment/jobs/create" />}>
                <Plus data-icon="inline-start" /> Post a job
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        {stats.map((s) => {
          const Icon = s.icon
          return (
            <Link key={s.label} href={s.href} className="group">
              <Card size="sm" className="h-full transition-colors group-hover:border-primary/50">
                <CardContent className="flex flex-col gap-1 py-1">
                  <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="mt-1 text-xl font-semibold tabular-nums">{isLoading ? "—" : s.value}</span>
                  <span className="text-xs font-medium leading-tight">{s.label}</span>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      {data?.stale && (data.stale.applications.total > 0 || data.stale.requisitions.total > 0 || data.stale.jobs.total > 0) && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500" />
              Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <StaleColumn
              title="Stale applications"
              caption={`Stuck ${data.stale.thresholds.applicationDays}+ days in a stage`}
              total={data.stale.applications.total}
              href="/modules/recruitment/job-applications"
              rows={data.stale.applications.items.map((a) => ({
                key: a.application_id,
                primary: a.candidate_name || a.application_id,
                secondary: `${a.job_title || "—"} · ${a.stage}`,
                meta: `${a.days_in_stage}d`,
              }))}
            />
            <StaleColumn
              title="Stale requisitions"
              caption="Past target date with pending roles"
              total={data.stale.requisitions.total}
              href="/modules/recruitment/requisition-hiring"
              rows={data.stale.requisitions.items.map((r) => ({
                key: r.requisition_id,
                primary: r.job_title || r.requisition_id,
                secondary: `Pending ${r.pending}/${r.required} · target ${r.target_date || "—"}`,
                meta: `${r.days_open}d`,
              }))}
            />
            <StaleColumn
              title="Stale jobs"
              caption={`No activity ${data.stale.thresholds.jobDays}+ days`}
              total={data.stale.jobs.total}
              href="/modules/recruitment/jobs"
              rows={data.stale.jobs.items.map((j) => ({
                key: j.job_id,
                primary: j.title,
                secondary: "No recent applications",
                meta: `${j.days_since_activity}d`,
              }))}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recruitment funnel</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && funnel.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No applications yet.</p>
          )}
          {funnel.map((step) => {
            const barPct = funnelMax > 0 ? Math.round((step.count / funnelMax) * 100) : 0
            const convPct =
              funnel[0]?.count > 0 ? Math.round((step.count / funnel[0].count) * 100) : 0
            return (
              <div key={step.key} className="flex items-center gap-3">
                <div className="w-28 shrink-0 text-sm font-medium">{step.label}</div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${barPct}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">{step.count}</span>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{convPct}%</span>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent applications</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && (data?.recentApplications.length ?? 0) === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No applications yet.</p>
            )}
            {data?.recentApplications.map((a) => (
              <Link
                key={a.application_id}
                href="/modules/recruitment/job-applications"
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.candidate_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{a.job_title || "—"} · {formatDate(a.applied_at)}</p>
                </div>
                <StageBadge stage={a.stage} />
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Upcoming interviews</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && (data?.upcomingInterviews.length ?? 0) === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No interviews scheduled.</p>
            )}
            {data?.upcomingInterviews.map((i) => (
              <Link
                key={i.interview_id}
                href="/modules/recruitment/interview-schedule"
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{i.candidate_name || "—"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {i.job_title || "—"} · {i.mode ? labelFor(INTERVIEW_MODES, i.mode) : "—"}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(i.scheduled_at)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function StaleColumn({
  title,
  caption,
  total,
  href,
  rows,
}: {
  title: string
  caption: string
  total: number
  href: string
  rows: { key: string; primary: string; secondary: string; meta: string }[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{caption}</p>
        </div>
        <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-400">
          {total}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.length === 0 && <p className="py-2 text-xs text-muted-foreground">Nothing flagged.</p>}
        {rows.map((r) => (
          <Link
            key={r.key}
            href={href}
            className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{r.primary}</p>
              <p className="truncate text-xs text-muted-foreground">{r.secondary}</p>
            </div>
            <span className="shrink-0 text-xs font-medium tabular-nums text-amber-600 dark:text-amber-400">{r.meta}</span>
          </Link>
        ))}
      </div>
      {total > rows.length && (
        <Link href={href} className="text-xs font-medium text-primary hover:underline">
          View all {total} →
        </Link>
      )}
    </div>
  )
}
