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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { FileText, Upload } from "lucide-react"
import {
  SectionHeader,
  SearchInput,
  FilterChips,
  StatusBadge,
  RowActions,
  Panel,
  KpiCard,
  EmptyState,
  fmtDate,
} from "@/components/vendor-portal-admin/shared"
import {
  VENDOR_DOCUMENTS,
  DOCUMENT_CATEGORIES,
  type DocumentStatus,
} from "@/lib/vendor-portal/admin-data"

type Filter = "all" | DocumentStatus

export function DocumentsSection() {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [category, setCategory] = useState("all")

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: VENDOR_DOCUMENTS.length }
    for (const d of VENDOR_DOCUMENTS) c[d.status] = (c[d.status] ?? 0) + 1
    return c
  }, [])

  const filtered = useMemo(
    () =>
      VENDOR_DOCUMENTS.filter((d) => {
        if (filter !== "all" && d.status !== filter) return false
        if (category !== "all" && d.category !== category) return false
        if (query) {
          const q = query.toLowerCase()
          return d.name.toLowerCase().includes(q) || d.vendor.toLowerCase().includes(q)
        }
        return true
      }),
    [query, filter, category],
  )

  const options: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "approved", label: "Approved", count: counts.approved },
    { key: "pending", label: "Pending", count: counts.pending },
    { key: "expiring", label: "Expiring", count: counts.expiring },
    { key: "expired", label: "Expired", count: counts.expired },
    { key: "rejected", label: "Rejected", count: counts.rejected },
  ]

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Document Center"
        description="All vendor-shared and admin-issued documents with versioning, categories and expiry tracking."
        actions={
          <Button size="sm" onClick={() => toast.success("Document uploaded and shared with vendor")}>
            <Upload data-icon="inline-start" className="size-4" /> Upload &amp; share
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total documents" value={counts.all ?? 0} />
        <KpiCard label="Pending review" value={counts.pending ?? 0} tone="warning" />
        <KpiCard label="Expiring soon" value={counts.expiring ?? 0} tone="warning" />
        <KpiCard label="Expired" value={counts.expired ?? 0} tone="danger" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search document or vendor…" className="w-full sm:w-72" />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {DOCUMENT_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <FilterChips options={options} value={filter} onChange={setFilter} />

      <Panel>
        {filtered.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium">
                      <FileText className="size-4 text-muted-foreground" />
                      {d.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{d.vendor}</TableCell>
                  <TableCell>{d.category}</TableCell>
                  <TableCell className="tabular-nums">{d.version}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.size}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtDate(d.uploaded)}
                    <span className="block">{d.uploadedBy}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>
                  <TableCell>
                    <RowActions
                      label="Document"
                      actions={[
                        { label: "Preview" },
                        { label: "Download", onSelect: () => toast.success("Download started") },
                        { label: "Version history" },
                        { label: "Approve" },
                        { label: "Delete", destructive: true, separatorBefore: true },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={<FileText className="size-8" />} title="No documents" description="Nothing matches the current filters." />
        )}
      </Panel>
    </div>
  )
}
