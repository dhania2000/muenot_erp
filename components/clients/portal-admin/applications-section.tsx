"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState, KpiCard, SearchInput, SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import {
  APPLICATION_LABELS,
  APPLICATIONS,
  APPROVAL_PIPELINE,
  type PortalApplication,
} from "./data"
import { ClipboardCheck, FileCheck2, ShieldQuestion } from "lucide-react"

export function ApplicationsSection() {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [active, setActive] = useState<PortalApplication | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return APPLICATIONS.filter((a) => {
      if (status !== "all" && a.status !== status) return false
      if (!q) return true
      return [a.company, a.applicant, a.email, a.id].some((v) => v.toLowerCase().includes(q))
    })
  }, [query, status])

  const counts = {
    pending: APPLICATIONS.filter((a) => a.status === "pending").length,
    review: APPLICATIONS.filter((a) => a.status === "under_review" || a.status === "needs_info").length,
    approved: APPLICATIONS.filter((a) => a.status === "approved").length,
    rejected: APPLICATIONS.filter((a) => a.status === "rejected").length,
  }

  function decide(app: PortalApplication, label: string) {
    toast.success(`${label} — ${app.company}`)
    setActive(null)
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Applications & Approvals"
        description="Self-registration requests from clients awaiting review, verification and approval."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Pending review" value={counts.pending} tone="warning" />
        <KpiCard label="In review / info needed" value={counts.review} tone="warning" />
        <KpiCard label="Approved" value={counts.approved} tone="positive" />
        <KpiCard label="Rejected" value={counts.rejected} tone="danger" />
      </div>

      {/* Pipeline */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-3 text-sm font-semibold">Approval pipeline</p>
        <div className="flex flex-wrap items-center gap-2">
          {APPROVAL_PIPELINE.map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs">
                <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                  {i + 1}
                </span>
                {step}
              </span>
              {i < APPROVAL_PIPELINE.length - 1 ? <span className="text-muted-foreground">→</span> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search applications…" className="w-full sm:w-72" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending Review</SelectItem>
            <SelectItem value="under_review">Under Review</SelectItem>
            <SelectItem value="needs_info">Needs Information</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No applications" description="New self-registration requests will appear here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Application</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Docs</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Reviewer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => (
                <TableRow key={a.id} className="cursor-pointer" onClick={() => setActive(a)}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{a.company}</span>
                      <span className="text-xs text-muted-foreground">{a.id} · {a.applicant} · {a.email}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={a.verification} tone={portalStatusTone(a.verification)} className="capitalize" />
                  </TableCell>
                  <TableCell className="tabular-nums">{a.documents}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.submitted}</TableCell>
                  <TableCell className="text-sm">{a.reviewer ?? "Unassigned"}</TableCell>
                  <TableCell>
                    <StatusBadge label={APPLICATION_LABELS[a.status]} tone={portalStatusTone(a.status)} />
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {a.status === "pending" || a.status === "under_review" || a.status === "needs_info" ? (
                      <div className="flex justify-end gap-1.5">
                        <Button size="xs" onClick={() => decide(a, "Approved")}>Approve</Button>
                        <Button size="xs" variant="destructive" onClick={() => decide(a, "Rejected")}>Reject</Button>
                      </div>
                    ) : (
                      <Button size="xs" variant="ghost" onClick={() => setActive(a)}>Review</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Review drawer */}
      <Sheet open={!!active} onOpenChange={(v) => !v && setActive(null)}>
        <SheetContent className="sm:max-w-lg">
          {active ? (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {active.company}
                  <StatusBadge label={APPLICATION_LABELS[active.status]} tone={portalStatusTone(active.status)} />
                </SheetTitle>
                <SheetDescription>{active.id} · submitted {active.submitted}</SheetDescription>
              </SheetHeader>

              <div className="grid gap-3 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Applicant" value={active.applicant} />
                  <Field label="Email" value={active.email} />
                  <Field label="Phone" value={active.phone} />
                  <Field label="Country" value={active.country} />
                  <Field label="Industry" value={active.industry} />
                  <Field label="Employees" value={active.employees} />
                </div>
                <Separator />
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted"><ShieldQuestion className="size-4" /></span>
                  <div>
                    <p className="font-medium">Verification</p>
                    <StatusBadge label={active.verification} tone={portalStatusTone(active.verification)} className="capitalize" />
                  </div>
                  <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                    <FileCheck2 className="size-4" /> {active.documents} document(s)
                  </span>
                </div>
                <Separator />
                <div className="grid gap-2">
                  <p className="font-medium">Reviewer notes</p>
                  {active.notes.length ? (
                    active.notes.map((n, i) => (
                      <div key={i} className="rounded-lg border border-border p-2.5 text-xs">
                        <span className="font-medium">{n.author}</span>
                        <span className="text-muted-foreground"> · {n.at}</span>
                        <p className="mt-1">{n.text}</p>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">No notes yet.</p>
                  )}
                  <Textarea placeholder="Add a review note…" rows={3} />
                </div>
              </div>

              <div className="mt-auto grid gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={() => decide(active, "Approved")}>Approve & activate</Button>
                  <Button variant="destructive" onClick={() => decide(active, "Rejected")}>Reject</Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => decide(active, "Information requested")}>Request info</Button>
                  <Button variant="outline" onClick={() => decide(active, "Assigned to me")}>Assign to me</Button>
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
