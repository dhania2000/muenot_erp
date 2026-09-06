"use client"

import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Briefcase,
  CalendarClock,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Plus,
  Users,
} from "lucide-react"
import { PageHeader, StageBadge, StatusPill } from "@/components/recruit/recruit-shared"
import { APPLICATION_STAGES, formatDate, formatDateTime, labelFor, INTERVIEW_MODES } from "@/lib/recruit"

type Stats = {
  jobs: { total: number; open: number; positions: number }
  applications: { total: number; byStage: Record<string, number> }
  interviews: { total: number; upcoming: number }
  offers: { total: number; accepted: number }
  recentApplications: { application_id: string; candidate_name: string; job_title: string | null; stage: string; applied_at: string }[]
  upcomingInterviews: { interview_id: string; candidate_name: string | null; job_title: string | null; scheduled_at: string | null; mode: string | null; status: string }[]
}

export function DashboardClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading } = useSWR<Stats>("/api/recruit/dashboard", fetcher)

  const stats = [
    { label: "Open jobs", value: data?.jobs.open ?? 0, sub: `${data?.jobs.total ?? 0} total`, icon: Briefcase, href: "/modules/recruitment/jobs" },
    { label: "Open positions", value: data?.jobs.positions ?? 0, sub: "across all jobs", icon: LayoutDashboard, href: "/modules/recruitment/jobs" },
    { label: "Applications", value: data?.applications.total ?? 0, sub: "in the pipeline", icon: Users, href: "/modules/recruitment/job-applications" },
    { label: "Upcoming interviews", value: data?.interviews.upcoming ?? 0, sub: `${data?.interviews.total ?? 0} total`, icon: CalendarClock, href: "/modules/recruitment/interview-schedule" },
    { label: "Offers accepted", value: data?.offers.accepted ?? 0, sub: `${data?.offers.total ?? 0} sent`, icon: FileText, href: "/modules/recruitment/job-offer-letter" },
  ]

  const totalApps = data?.applications.total ?? 0

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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {stats.map((s) => {
          const Icon = s.icon
          return (
            <Link key={s.label} href={s.href} className="group">
              <Card size="sm" className="h-full transition-colors group-hover:border-primary/50">
                <CardContent className="flex flex-col gap-1.5 py-1">
                  <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="mt-1 text-2xl font-semibold tabular-nums">{isLoading ? "—" : s.value}</span>
                  <span className="text-xs font-medium">{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.sub}</span>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Application pipeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {APPLICATION_STAGES.map((stage) => {
            const count = data?.applications.byStage[stage.key] ?? 0
            const pct = totalApps > 0 ? Math.round((count / totalApps) * 100) : 0
            return (
              <div key={stage.key} className="flex items-center gap-3">
                <div className="w-28 shrink-0">
                  <StageBadge stage={stage.key} />
                </div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{count}</span>
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
