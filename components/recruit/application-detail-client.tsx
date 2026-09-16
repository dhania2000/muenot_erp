"use client"

import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft,
  Briefcase,
  CheckCircle2,
  ClipboardList,
  FileCheck,
  Loader2,
  Mail,
  Phone,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react"
import { PageHeader, StageBadge, StatusPill, EmptyState, RatingStars } from "@/components/recruit/recruit-shared"
import { Fact, DetailSection, fmtDate, fmtMoney } from "@/components/recruit/detail-shared"

function TimelineRow({
  icon: Icon,
  title,
  meta,
  children,
  done,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  meta?: React.ReactNode
  children?: React.ReactNode
  done?: boolean
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={
            "flex size-8 items-center justify-center rounded-full border " +
            (done ? "bg-primary/10 text-primary border-primary/30" : "bg-muted text-muted-foreground")
          }
        >
          <Icon className="size-4" />
        </div>
        <div className="mt-1 w-px flex-1 bg-border last:hidden" />
      </div>
      <div className="flex-1 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{title}</span>
          {meta}
        </div>
        {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
      </div>
    </div>
  )
}

export function ApplicationDetailClient({
  applicationId,
  canManage,
}: {
  applicationId: string
  canManage: boolean
}) {
  const { data, isLoading } = useSWR<any>(
    `/api/recruit/applications/${encodeURIComponent(applicationId)}/detail`,
    fetcher,
  )

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!data?.application) {
    return (
      <main className="flex flex-col gap-6 p-6 md:p-8">
        <Button variant="ghost" size="sm" render={<Link href="/modules/recruitment/job-applications" />}>
          <ArrowLeft className="size-4" /> Back to applications
        </Button>
        <EmptyState message="This application could not be found." />
      </main>
    )
  }

  const {
    application: a,
    candidate,
    job,
    requisition,
    screenings,
    assessments,
    interviews,
    feedback,
    selections,
    offers,
    verifications,
    references,
    preJoining,
    employee,
  } = data

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit -ml-2"
        render={<Link href="/modules/recruitment/job-applications" />}
      >
        <ArrowLeft className="size-4" /> Back to applications
      </Button>

      <PageHeader
        title={a.candidate_name}
        description={`${a.application_id}${job ? ` · ${job.title}` : ""}`}
        icon={UserRound}
        action={
          <div className="flex items-center gap-2">
            <StageBadge stage={a.stage} />
            {employee && (
              <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3" /> Hired
              </Badge>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Candidate */}
        <DetailSection
          title="Candidate"
          description="From the Candidate Master"
          action={
            candidate && (
              <Button
                variant="outline"
                size="sm"
                render={<Link href={`/modules/recruitment/candidate-360?id=${candidate.candidate_id}`} />}
              >
                360 view
              </Button>
            )
          }
        >
          <div className="grid grid-cols-2 gap-4">
            <Fact
              label="Email"
              value={
                a.email ? (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="size-3" /> {a.email}
                  </span>
                ) : null
              }
            />
            <Fact
              label="Phone"
              value={
                a.phone ? (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="size-3" /> {a.phone}
                  </span>
                ) : null
              }
            />
            <Fact label="Experience" value={a.experience ?? candidate?.total_experience} />
            <Fact label="Current CTC" value={candidate?.current_ctc} />
            <Fact label="Expected CTC" value={candidate?.expected_ctc} />
            <Fact label="Notice period" value={candidate?.notice_period} />
            <Fact label="Source" value={a.source} />
            <Fact label="Master ID" value={a.candidate_master_id} />
          </div>
        </DetailSection>

        {/* Job */}
        <DetailSection title="Job" description="Applied position">
          {job ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Fact label="Job" value={job.title} />
                <Fact label="Department" value={job.department} />
                <Fact label="Location" value={job.location} />
                <Fact label="Status" value={<StatusPill status={job.status} kind="job" />} />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                render={<Link href={`/modules/recruitment/jobs/${job.job_id}`} />}
              >
                <Briefcase className="size-4" /> View job
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No job linked.</p>
          )}
        </DetailSection>

        {/* Requisition */}
        <DetailSection title="Requisition" description="Originating demand">
          {requisition ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Fact label="Requisition" value={requisition.requisition_id} />
                <Fact label="Priority" value={requisition.priority} />
                <Fact
                  label="Approval"
                  value={<StatusPill status={requisition.approval_status || "draft"} />}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                render={
                  <Link href={`/modules/recruitment/job-requisitions/${requisition.requisition_id}`} />
                }
              >
                <ClipboardList className="size-4" /> View requisition
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No requisition linked.</p>
          )}
        </DetailSection>
      </div>

      {/* Journey timeline */}
      <DetailSection title="Journey" description="Every stage this application has passed through">
        <div className="flex flex-col">
          <TimelineRow icon={Users} title="Applied" done meta={<span className="text-xs text-muted-foreground">{fmtDate(a.applied_at)}</span>}>
            Applied via {a.source || "direct"}.
          </TimelineRow>

          {screenings.length > 0 && (
            <TimelineRow icon={ClipboardList} title="Screening" done>
              {screenings.map((s: any) => (
                <div key={s.id} className="flex items-center gap-2">
                  <span>{s.status || s.result || "Screened"}</span>
                  {s.score != null && <Badge variant="secondary">{s.score}</Badge>}
                </div>
              ))}
            </TimelineRow>
          )}

          {assessments.length > 0 && (
            <TimelineRow icon={ClipboardList} title="Assessment" done>
              {assessments.map((s: any) => (
                <div key={s.id}>
                  {s.assessment_name || s.name || "Assessment"} — {s.score ?? s.result ?? s.status ?? "—"}
                </div>
              ))}
            </TimelineRow>
          )}

          {interviews.length > 0 && (
            <TimelineRow icon={Users} title="Interviews" done>
              <div className="flex flex-col gap-2">
                {interviews.map((iv: any) => (
                  <div key={iv.interview_id || iv.id} className="flex flex-wrap items-center gap-2">
                    <span>{iv.round || iv.interview_round || iv.stage || "Round"}</span>
                    <span className="text-xs">{fmtDate(iv.scheduled_at || iv.interview_date)}</span>
                    {iv.status && <StatusPill status={iv.status} kind="interview" />}
                  </div>
                ))}
              </div>
            </TimelineRow>
          )}

          {feedback.length > 0 && (
            <TimelineRow icon={ClipboardList} title="Feedback" done>
              <div className="flex flex-col gap-2">
                {feedback.map((f: any) => (
                  <div key={f.id} className="flex items-center gap-2">
                    {f.rating != null && <RatingStars value={Number(f.rating)} readOnly />}
                    <span>{f.recommendation || f.comments || "—"}</span>
                  </div>
                ))}
              </div>
            </TimelineRow>
          )}

          {selections.length > 0 && (
            <TimelineRow icon={CheckCircle2} title="Selection" done>
              {selections.map((s: any) => (
                <div key={s.id}>{s.decision || s.status || "Selected"}</div>
              ))}
            </TimelineRow>
          )}

          {offers.length > 0 && (
            <TimelineRow icon={FileCheck} title="Offer" done>
              <div className="flex flex-col gap-2">
                {offers.map((o: any) => (
                  <div key={o.offer_id} className="flex flex-wrap items-center gap-2">
                    <span>{fmtMoney(o.salary, o.currency)}</span>
                    <StatusPill status={o.status} kind="offer" />
                    <span className="text-xs">Joining {fmtDate(o.joining_date)}</span>
                  </div>
                ))}
              </div>
            </TimelineRow>
          )}

          {verifications.length > 0 && (
            <TimelineRow icon={ShieldCheck} title="Background verification" done>
              {verifications.map((v: any) => (
                <div key={v.id || v.check_id}>
                  {v.check_type || v.type || "Check"} — {v.status || v.result || "—"}
                </div>
              ))}
            </TimelineRow>
          )}

          {references.length > 0 && (
            <TimelineRow icon={ShieldCheck} title="Reference checks" done>
              {references.map((v: any) => (
                <div key={v.id || v.reference_id}>
                  {v.referee_name || v.reference_name || "Reference"} — {v.status || v.result || "—"}
                </div>
              ))}
            </TimelineRow>
          )}

          {preJoining.length > 0 && (
            <TimelineRow icon={ClipboardList} title="Pre-joining" done>
              {preJoining.map((v: any) => (
                <div key={v.id || v.task_id}>
                  {v.task_name || v.task || "Task"} — {v.status || "—"}
                </div>
              ))}
            </TimelineRow>
          )}

          {employee && (
            <TimelineRow
              icon={CheckCircle2}
              title="Joined as employee"
              done
              meta={
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link href={`/modules/hr/employees/${employee.employee_id}`} />}
                >
                  View employee
                </Button>
              }
            >
              {employee.employee_id} · {employee.designation || employee.department || "Onboarded"}
            </TimelineRow>
          )}
        </div>
      </DetailSection>
    </main>
  )
}
