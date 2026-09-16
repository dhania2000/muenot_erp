"use client"

import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ArrowLeft, Briefcase, ClipboardList, Coins, Gauge, Loader2, Users } from "lucide-react"
import { PageHeader, StageBadge, StatusPill, EmptyState } from "@/components/recruit/recruit-shared"
import { StatCard, Fact, DetailSection, fmtDate, fmtMoney } from "@/components/recruit/detail-shared"

export function RequisitionDetailClient({
  requisitionId,
  canManage,
}: {
  requisitionId: string
  canManage: boolean
}) {
  const { data, isLoading } = useSWR<any>(
    `/api/recruit/requisitions/${encodeURIComponent(requisitionId)}/detail`,
    fetcher,
  )

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!data?.requisition) {
    return (
      <main className="flex flex-col gap-6 p-6 md:p-8">
        <Button variant="ghost" size="sm" render={<Link href="/modules/recruitment/job-requisitions" />}>
          <ArrowLeft className="size-4" /> Back to requisitions
        </Button>
        <EmptyState message="This requisition could not be found." />
      </main>
    )
  }

  const { requisition: r, jobs, applications, counts, headcount, budget } = data
  const fillPct = headcount.required > 0 ? Math.round((headcount.filled / headcount.required) * 100) : 0
  const currency = r.currency || "INR"

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit -ml-2"
        render={<Link href="/modules/recruitment/job-requisitions" />}
      >
        <ArrowLeft className="size-4" /> Back to requisitions
      </Button>

      <PageHeader
        title={r.job_title || "Requisition"}
        description={`${r.requisition_id}${r.department ? ` · ${r.department}` : ""}`}
        icon={ClipboardList}
        action={<StatusPill status={r.approval_status || "draft"} />}
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Required" value={headcount.required} icon={Users} />
        <StatCard label="Filled" value={headcount.filled} icon={Users} />
        <StatCard label="Remaining" value={headcount.remaining} icon={Gauge} />
        <StatCard label="Applications" value={counts.total} icon={ClipboardList} />
        <StatCard label="Budget" value={fmtMoney(budget.budget, currency)} icon={Coins} />
        <StatCard
          label="Remaining budget"
          value={fmtMoney(budget.variance, currency)}
          icon={Coins}
          hint={`${fmtMoney(budget.actual, currency)} spent`}
        />
      </div>

      {/* Fill progress */}
      <DetailSection title="Hiring progress" description={`${headcount.filled} of ${headcount.required} positions filled`}>
        <div className="flex flex-col gap-2">
          <Progress value={fillPct} />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{fillPct}% filled</span>
            <span>{headcount.remaining} open</span>
          </div>
        </div>
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Requisition details */}
        <DetailSection title="Requisition details" description="Demand specification">
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Raised" value={fmtDate(r.requisition_date)} />
            <Fact label="Priority" value={r.priority} />
            <Fact label="Designation" value={r.designation} />
            <Fact label="Location" value={r.location} />
            <Fact label="Employment" value={r.employment_type} />
            <Fact label="Work mode" value={r.work_mode} />
            <Fact label="Experience" value={r.experience_required} />
            <Fact label="Qualification" value={r.required_qualification} />
            <Fact label="Hiring manager" value={r.hiring_manager} />
            <Fact label="Recruiter" value={r.recruiter} />
            {r.required_skills && (
              <Fact className="col-span-2" label="Skills" value={r.required_skills} />
            )}
            {r.remarks && <Fact className="col-span-2" label="Remarks" value={r.remarks} />}
          </div>
        </DetailSection>

        {/* Approval trail */}
        <DetailSection title="Approval trail" description="Who moved this forward">
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Status" value={<StatusPill status={r.approval_status || "draft"} />} />
            <Fact label="Submitted by" value={r.submitted_by_name} />
            <Fact label="Submitted" value={fmtDate(r.submitted_at)} />
            <Fact label="Approved by" value={r.approved_by_name} />
            <Fact label="Approved" value={fmtDate(r.approved_at)} />
            {r.rejected_by_name && <Fact label="Rejected by" value={r.rejected_by_name} />}
            {r.rejection_reason && (
              <Fact className="col-span-2" label="Rejection reason" value={r.rejection_reason} />
            )}
            {r.approval_notes && (
              <Fact className="col-span-2" label="Notes" value={r.approval_notes} />
            )}
          </div>
        </DetailSection>

        {/* Linked jobs */}
        <DetailSection title="Linked jobs" description="Postings created from this requisition">
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No job has been created yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {jobs.map((j: any) => (
                <Link
                  key={j.job_id}
                  href={`/modules/recruitment/jobs/${j.job_id}`}
                  className="flex items-center justify-between rounded-md border p-3 text-sm hover:bg-muted/50"
                >
                  <span className="flex items-center gap-2">
                    <Briefcase className="size-4 text-muted-foreground" />
                    <span className="font-medium">{j.title}</span>
                  </span>
                  <StatusPill status={j.status} kind="job" />
                </Link>
              ))}
            </div>
          )}
        </DetailSection>
      </div>

      {/* Applications rolled up */}
      <DetailSection
        title="Candidates"
        description={`${applications.length} application${applications.length === 1 ? "" : "s"} across linked jobs`}
      >
        {applications.length === 0 ? (
          <EmptyState message="No candidates have applied yet." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Stage</TableHead>
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
                    <TableCell className="text-sm text-muted-foreground">{a.job_title || "—"}</TableCell>
                    <TableCell>
                      <StageBadge stage={a.stage} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(a.applied_at)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        render={<Link href={`/modules/recruitment/job-applications/${a.application_id}`} />}
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

      {/* Cost breakdown */}
      {budget.entries.length > 0 && (
        <DetailSection
          title="Recruitment cost"
          description={`Budget ${fmtMoney(budget.budget, currency)} · Actual ${fmtMoney(budget.actual, currency)}`}
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead>Payment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {budget.entries.map((c: any) => (
                  <TableRow key={c.cost_id}>
                    <TableCell className="font-medium">{c.cost_category || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.vendor_name || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(c.budget_amount, currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(c.actual_amount, currency)}</TableCell>
                    <TableCell>{c.payment_status ? <StatusPill status={String(c.payment_status).toLowerCase()} /> : "—"}</TableCell>
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
