"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  FileSearch,
  CheckCircle2,
  XCircle,
  Info,
  UserCheck,
  StickyNote,
  Copy,
  Link2,
  UserPlus,
  ArrowDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { SectionHeader, SearchInput, FilterChips, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import { APPLICATIONS, APPLICATION_STATUS_LABEL, ONBOARDING_WORKFLOW, type Application } from "./mock-data"

type FilterKey = "all" | Application["status"]

const COLUMNS: Column[] = [
  { key: "id", header: "Application" },
  { key: "company", header: "Company" },
  { key: "type", header: "Type" },
  { key: "applicant", header: "Applicant" },
  { key: "country", header: "Country" },
  { key: "submitted", header: "Submitted" },
  { key: "documents", header: "Docs", align: "right" },
  { key: "compliance", header: "Compliance" },
  { key: "reviewer", header: "Reviewer" },
  { key: "status", header: "Status" },
]

export function ApplicationsSection() {
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<FilterKey>("all")
  const [review, setReview] = useState<Application | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return APPLICATIONS.filter((a) => {
      if (q && !`${a.company} ${a.applicant} ${a.id} ${a.email}`.toLowerCase().includes(q)) return false
      if (filter !== "all" && a.status !== filter) return false
      return true
    })
  }, [search, filter])

  const filterOptions: { value: FilterKey; label: string; count?: number }[] = [
    { value: "all", label: "All", count: APPLICATIONS.length },
    ...(Object.keys(APPLICATION_STATUS_LABEL) as Application["status"][]).map((s) => ({
      value: s,
      label: APPLICATION_STATUS_LABEL[s],
      count: APPLICATIONS.filter((a) => a.status === s).length,
    })),
  ]

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Vendor Self-Registration & Approval"
        description="Manage vendor applications submitted through the portal. Review, approve, reject or request information at each stage."
        icon={FileSearch}
      />

      {/* Workflow visualization */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-3 text-sm font-semibold">Onboarding approval workflow</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
          {ONBOARDING_WORKFLOW.map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {i + 1}
                </span>
                <span className="text-xs font-medium">{step}</span>
              </div>
              {i < ONBOARDING_WORKFLOW.length - 1 ? (
                <ArrowDown className="size-3.5 rotate-[-90deg] text-muted-foreground" />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search applications…" />
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
      </div>

      <AdminTable
        columns={COLUMNS}
        rows={filtered}
        onRowClick={setReview}
        empty={<EmptyState icon={FileSearch} title="No applications" description="No vendor applications match your filters." />}
        render={(a, key) => {
          switch (key) {
            case "id":
              return <span className="font-mono text-xs">{a.id}</span>
            case "company":
              return <span className="font-medium">{a.company}</span>
            case "type":
              return <span className="text-muted-foreground">{a.type}</span>
            case "applicant":
              return (
                <div className="grid">
                  <span>{a.applicant}</span>
                  <span className="text-xs text-muted-foreground">{a.email}</span>
                </div>
              )
            case "country":
              return <span className="text-muted-foreground">{a.country}</span>
            case "submitted":
              return <span className="text-muted-foreground">{a.submitted}</span>
            case "documents":
              return <span className="tabular-nums">{a.documents}</span>
            case "compliance":
              return <StatusBadge status={a.compliance} label={a.compliance} />
            case "reviewer":
              return <span className="text-muted-foreground">{a.reviewer ?? "Unassigned"}</span>
            case "status":
              return <StatusBadge status={a.status} label={APPLICATION_STATUS_LABEL[a.status]} />
            default:
              return null
          }
        }}
      />

      <Dialog open={review !== null} onOpenChange={(o) => !o && setReview(null)}>
        <DialogContent className="sm:max-w-lg">
          {review ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {review.company}
                  <StatusBadge status={review.status} label={APPLICATION_STATUS_LABEL[review.status]} />
                </DialogTitle>
                <DialogDescription>
                  {review.id} · Submitted {review.submitted} · {review.country}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Applicant</p>
                    <p className="font-medium">{review.applicant}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="font-medium">{review.email}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Phone</p>
                    <p className="font-medium">{review.phone}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Vendor type</p>
                    <p className="font-medium">{review.type}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Documents</p>
                    <p className="font-medium">{review.documents} attached</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Reviewer</p>
                    <p className="font-medium">{review.reviewer ?? "Unassigned"}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => toast.success("Reviewer assigned")}>
                    <UserCheck className="size-3.5" /> Assign Reviewer
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => toast.success("Internal note added")}>
                    <StickyNote className="size-3.5" /> Add Note
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => toast.success("Marked as duplicate")}>
                    <Copy className="size-3.5" /> Mark Duplicate
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => toast.success("Linked to existing vendor")}>
                    <Link2 className="size-3.5" /> Link Existing
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => toast.success("Vendor record created")}>
                    <UserPlus className="size-3.5" /> Create Vendor
                  </Button>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => toast.success("Information requested")}>
                  <Info className="size-4" /> Request Info
                </Button>
                <Button variant="destructive" size="sm" onClick={() => { toast.success("Application rejected"); setReview(null) }}>
                  <XCircle className="size-4" /> Reject
                </Button>
                <Button size="sm" onClick={() => { toast.success("Application approved"); setReview(null) }}>
                  <CheckCircle2 className="size-4" /> Approve
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
