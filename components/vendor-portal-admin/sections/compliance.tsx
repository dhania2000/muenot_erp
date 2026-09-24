"use client"

import { useMemo, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"
import { BadgeCheck } from "lucide-react"
import {
  SectionHeader,
  SearchInput,
  FilterChips,
  StatusBadge,
  RowActions,
  Panel,
  KpiCard,
  EmptyState,
} from "@/components/vendor-portal-admin/shared"
import { COMPLIANCE_DOCS, type ComplianceStatus } from "@/lib/vendor-portal/admin-data"

type Filter = "all" | ComplianceStatus

export function ComplianceSection() {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: COMPLIANCE_DOCS.length }
    for (const d of COMPLIANCE_DOCS) c[d.status] = (c[d.status] ?? 0) + 1
    return c
  }, [])

  const filtered = useMemo(
    () =>
      COMPLIANCE_DOCS.filter((d) => {
        if (filter !== "all" && d.status !== filter) return false
        if (query) {
          const q = query.toLowerCase()
          return d.vendor.toLowerCase().includes(q) || d.document.toLowerCase().includes(q) || d.number.toLowerCase().includes(q)
        }
        return true
      }),
    [query, filter],
  )

  const options: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "verified", label: "Verified", count: counts.verified },
    { key: "pending", label: "Pending", count: counts.pending },
    { key: "expiring", label: "Expiring", count: counts.expiring },
    { key: "expired", label: "Expired", count: counts.expired },
    { key: "rejected", label: "Rejected", count: counts.rejected },
  ]

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Tax & Compliance"
        description="Track GST/VAT, tax IDs, registrations, insurance and certifications with issue and expiry monitoring."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Verified" value={counts.verified ?? 0} tone="success" />
        <KpiCard label="Pending review" value={counts.pending ?? 0} tone="warning" />
        <KpiCard label="Expiring soon" value={counts.expiring ?? 0} tone="warning" />
        <KpiCard label="Expired" value={counts.expired ?? 0} tone="danger" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search vendor, document, number…" className="w-full sm:w-80" />
      </div>
      <FilterChips options={options} value={filter} onChange={setFilter} />

      <Panel>
        {filtered.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.vendor}</TableCell>
                  <TableCell>{d.document}</TableCell>
                  <TableCell className="text-muted-foreground">{d.type}</TableCell>
                  <TableCell className="font-mono text-xs">{d.number}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.issued}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.expiry}</TableCell>
                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>
                  <TableCell>
                    <RowActions
                      label="Compliance"
                      actions={[
                        { label: "View document" },
                        { label: "Mark verified", onSelect: () => toast.success("Marked verified") },
                        { label: "Request renewal" },
                        { label: "Reject", destructive: true, separatorBefore: true },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={<BadgeCheck className="size-8" />} title="No compliance records" description="Nothing matches the current filters." />
        )}
      </Panel>
    </div>
  )
}
