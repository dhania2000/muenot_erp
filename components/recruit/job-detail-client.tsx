"use client"

import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ArrowLeft,
  Briefcase,
  CalendarClock,
  ClipboardList,
  FileCheck,
  Loader2,
  Pencil,
  Users,
} from "lucide-react"
import { PageHeader, StageBadge, StatusPill, EmptyState } from "@/components/recruit/recruit-shared"
import { StatCard, Fact, DetailSection, fmtDate, fmtMoney } from "@/components/recruit/detail-shared"
import { JOB_TYPES, WORK_MODES, labelFor, salaryRange } from "@/lib/recruit"

export function JobDetailClient({ jobId, canManage }: { jobId: string; canManage: boolean }) {
  const { data, isLoading } = useSWR<any>(
    `/api/recruit/jobs/${encodeURIComponent(jobId)}/detail`,
    fetcher,
  )

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!data?.job) {
    return (
      <main className="flex flex-col gap-6 p-6 md:p-8">
        <Button variant="ghost" size="sm" render={<Link href="/modules/recruitment/jobs" />}>
          <ArrowLeft className="size-4" /> Back to jobs
        </Button>
        <EmptyState message="This job could not be found." />
      </main>
    )
  }

  const { job, requisition, applications, interviews, offers, counts, remaining } = data

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit -ml-2"
        render={<Link href="/modules/recruitment/jobs" />}
      >
        <ArrowLeft className="size-4" /> Back to jobs
      </Button>

      <PageHeader
        title={job.title}
        description={`${job.job_id}${job.department ? ` · ${job.department}` : ""}`}
        icon={Briefcase}
        action={
          <div className="flex items-center gap-2">
            <StatusPill status={job.status} kind="job" />
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                render={<Link href={`/modules/recruitment/jobs/${job.job_id}/edit`} />}
              >
                <Pencil className="size-4" /> Edit
              </Button>
            )}
          </div>
        }
      />

      {/* Hiring funnel */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Applications" value={counts.total} icon={Users} />
        <StatCard label="Shortlisted" value={counts.shortlisted} icon={ClipboardList} />
        <StatCard label="Interviews" value={interviews.length} icon={CalendarClock} />
        <StatCard label="Offers" value={offers.length} icon={FileCheck} />
        <StatCard label="Joined" value={counts.joined} icon={Users} />
        <StatCard
          label="Open positions"
          value={remaining}
          icon={Briefcase}
          hint={`of ${job.positions ?? 1}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Job details */}
        <DetailSection title="Job details" description="Posting information" >
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Type" value={labelFor(JOB_TYPES, job.job_type)} />
            <Fact label="Work mode" value={labelFor(WORK_MODES, job.work_mode)} />
            <Fact label="Location" value={job.location} />
            <Fact label="Experience" value={job.experience} />
            <Fact label="Salary" value={salaryRange(job.salary_from, job.salary_to, job.currency)} />
            <Fact label="Positions" value={job.positions} />
            <Fact label="Recruiter" value={job.recruiter} />
            <Fact label="Hiring manager" value={job.hiring_manager} />
            <Fact label="Posted" value={fmtDate(job.created_at)} />
            <Fact label="Source" value={job.source || job.campaign} />
            {job.skills && <Fact className="col-span-2" label="Skills" value={job.skills} />}
          </div>
        </DetailSection>

        {/* Requisition link */}
        <DetailSection title="Requisition" description="Originating demand">
          {requisition ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Fact label="Requisition" value={requisition.requisition_id} />
                <Fact label="Priority" value={requisition.priority} />
                <Fact label="Required" value={requisition.required_resources} />
                <Fact label="Filled" value={requisition.filled_resources} />
                <Fact
                  className="col-span-2"
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
                View requisition
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This job was posted directly, without a linked requisition.
            </p>
          )}
        </DetailSection>

        {/* Description */}
        <DetailSection title="Description" description="Role summary & requirements">
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-xs text-muted-foreground">Description</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-pretty">
                {job.description || "—"}
              </p>
            </div>
            {job.requirements && (
              <div>
                <div className="text-xs text-muted-foreground">Requirements</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-pretty">{job.requirements}</p>
              </div>
            )}
          </div>
        </DetailSection>
      </div>

      {/* Applications */}
      <DetailSection
        title="Applications"
        description={`${applications.length} candidate${applications.length === 1 ? "" : "s"} against this job`}
        action={
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/modules/recruitment/job-applications?jobId=${job.job_id}`} />}
          >
            Open pipeline
          </Button>
        }
      >
        {applications.length === 0 ? (
          <EmptyState message="No applications yet." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Applied</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications.map((a: any) => (
                  <TableRow key={a.application_id}>
                    <TableCell>
                      <div className="font-medium">{a.candidate_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.email || a.phone || a.application_id}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StageBadge stage={a.stage} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{a.source || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(a.applied_at)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        render={
                          <Link href={`/modules/recruitment/job-applications/${a.application_id}`} />
                        }
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DetailSection>

      {/* Offers */}
      {offers.length > 0 && (
        <DetailSection title="Offers" description={`${offers.length} offer${offers.length === 1 ? "" : "s"} extended`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Salary</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joining</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offers.map((o: any) => (
                  <TableRow key={o.offer_id}>
                    <TableCell className="font-medium">{o.candidate_name}</TableCell>
                    <TableCell>{fmtMoney(o.salary, o.currency)}</TableCell>
                    <TableCell>
                      <StatusPill status={o.status} kind="offer" />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(o.joining_date)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DetailSection>
      )}
    </main>
  )
}
