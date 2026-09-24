"use client"

import { useMemo, useState } from "react"
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { CheckCircle2, XCircle, FileText, HelpCircle } from "lucide-react"
import {
  SectionHeader,
  SearchInput,
  FilterChips,
  StatusBadge,
  RowActions,
  EmptyState,
  Panel,
  KpiCard,
  fmtDate,
} from "@/components/vendor-portal-admin/shared"
import {
  APPLICATIONS,
  type Application,
  type ApplicationStatus,
  APPLICATION_STATUS_LABEL,
} from "@/lib/vendor-portal/admin-data"

type Filter = "all" | ApplicationStatus

export function ApplicationsSection() {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [active, setActive] = useState<Application | null>(null)
  const [open, setOpen] = useState(false)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: APPLICATIONS.length }
    for (const a of APPLICATIONS) c[a.status] = (c[a.status] ?? 0) + 1
    return c
  }, [])

  const filtered = useMemo(
    () =>
      APPLICATIONS.filter((a) => {
        if (filter !== "all" && a.status !== filter) return false
        if (query) {
          const q = query.toLowerCase()
          return a.company.toLowerCase().includes(q) || a.applicant.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)
        }
        return true
      }),
    [query, filter],
  )

  const options: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "pending", label: "Pending", count: counts.pending },
    { key: "under-review", label: "Under review", count: counts["under-review"] },
    { key: "needs-info", label: "Needs info", count: counts["needs-info"] },
    { key: "approved", label: "Approved", count: counts.approved },
    { key: "rejected", label: "Rejected", count: counts.rejected },
    { key: "expired", label: "Expired", count: counts.expired },
  ]

  const openApp = (a: Application) => {
    setActive(a)
    setOpen(true)
  }

  const act = (verb: string) => {
    setOpen(false)
    toast.success(`Application ${active?.id} — ${verb}`)
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Vendor Applications"
        description="Self-registered vendors and manual applications awaiting review, verification and approval."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Awaiting review" value={counts.pending ?? 0 + (counts["under-review"] ?? 0)} tone="warning" />
        <KpiCard label="Needs information" value={counts["needs-info"] ?? 0} tone="warning" />
        <KpiCard label="Approved (30d)" value={counts.approved ?? 0} tone="success" />
        <KpiCard label="Rejected (30d)" value={counts.rejected ?? 0} tone="danger" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search company, applicant…" className="w-full sm:w-72" />
      </div>
      <FilterChips options={options} value={filter} onChange={setFilter} />

      <Panel>
        {filtered.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Application</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Docs</TableHead>
                <TableHead>Compliance</TableHead>
                <TableHead>Reviewer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => (
                <TableRow key={a.id} className="cursor-pointer" onClick={() => openApp(a)}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{a.company}</span>
                      <span className="text-xs text-muted-foreground">
                        {a.id} · {a.applicant}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{a.type}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(a.submitted)}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.documents}</TableCell>
                  <TableCell>
                    <StatusBadge status={a.compliance} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{a.reviewer ?? "Unassigned"}</TableCell>
                  <TableCell>
                    <StatusBadge status={a.status} label={APPLICATION_STATUS_LABEL[a.status]} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      actions={[
                        { label: "Review application", onSelect: () => openApp(a) },
                        { label: "Approve" },
                        { label: "Request information" },
                        { label: "Reject", destructive: true, separatorBefore: true },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={<FileText className="size-8" />} title="No applications" description="New vendor registrations will appear here for review." />
        )}
      </Panel>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          {active ? (
            <>
              <SheetHeader className="border-b border-border">
                <SheetTitle className="flex items-center gap-2">
                  {active.company}
                  <StatusBadge status={active.status} label={APPLICATION_STATUS_LABEL[active.status]} />
                </SheetTitle>
                <SheetDescription>
                  {active.id} · Submitted {fmtDate(active.submitted)}
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
                <section>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Applicant</h4>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-xs text-muted-foreground">Name</dt><dd className="font-medium">{active.applicant}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="font-medium">{active.email}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Phone</dt><dd className="font-medium">{active.phone}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Country</dt><dd className="font-medium">{active.country}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Type</dt><dd className="font-medium">{active.type}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Compliance</dt><dd><StatusBadge status={active.compliance} /></dd></div>
                  </dl>
                </section>

                <section>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Submitted documents ({active.documents})</h4>
                  <ul className="grid gap-2">
                    {Array.from({ length: active.documents }).map((_, i) => (
                      <li key={i} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                        <span className="flex items-center gap-2">
                          <FileText className="size-4 text-muted-foreground" />
                          {["Registration Certificate", "Tax Certificate", "Bank Proof", "Address Proof", "Owner ID", "Insurance"][i] ?? `Document ${i + 1}`}.pdf
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => toast.success("Marked verified")}>
                          Verify
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="grid gap-2">
                  <Label htmlFor="app-note">Review note</Label>
                  <Textarea id="app-note" placeholder="Add an internal note or the reason shown to the vendor…" rows={3} />
                </section>
              </div>
              <SheetFooter className="flex-row flex-wrap gap-2 border-t border-border">
                <Button size="sm" onClick={() => act("approved")}>
                  <CheckCircle2 data-icon="inline-start" className="size-4" /> Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => act("information requested")}>
                  <HelpCircle data-icon="inline-start" className="size-4" /> Request info
                </Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => act("rejected")}>
                  <XCircle data-icon="inline-start" className="size-4" /> Reject
                </Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
