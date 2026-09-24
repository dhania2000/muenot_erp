"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
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
import { ACCESS_REQUESTS, REQUEST_LABELS, type AccessRequest } from "./data"
import { Inbox } from "lucide-react"

export function RequestsSection() {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ACCESS_REQUESTS.filter((r) => {
      if (status !== "all" && r.status !== status) return false
      if (!q) return true
      return [r.id, r.type, r.client, r.requestedBy, r.detail].some((v) => v.toLowerCase().includes(q))
    })
  }, [query, status])

  const counts = {
    new: ACCESS_REQUESTS.filter((r) => r.status === "new").length,
    review: ACCESS_REQUESTS.filter((r) => r.status === "in_review").length,
    approved: ACCESS_REQUESTS.filter((r) => r.status === "approved").length,
    rejected: ACCESS_REQUESTS.filter((r) => r.status === "rejected").length,
  }

  function decide(r: AccessRequest, label: string) {
    toast.success(`${label} — ${r.id}`)
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Access Requests"
        description="Client-submitted requests for additional access, new users, documents and account changes."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="New" value={counts.new} tone="warning" />
        <KpiCard label="In review" value={counts.review} tone="warning" />
        <KpiCard label="Approved" value={counts.approved} tone="positive" />
        <KpiCard label="Rejected" value={counts.rejected} tone="danger" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search requests…" className="w-full sm:w-72" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="in_review">In Review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Inbox} title="No requests" description="Access requests from clients will appear here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Reviewer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{r.id} · {r.requestedBy}</span>
                      <span className="max-w-md truncate text-xs text-muted-foreground">{r.detail}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.type}</TableCell>
                  <TableCell className="text-sm">{r.client}</TableCell>
                  <TableCell className="text-sm">{r.reviewer ?? "Unassigned"}</TableCell>
                  <TableCell>
                    <StatusBadge label={REQUEST_LABELS[r.status]} tone={portalStatusTone(r.status)} />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "new" || r.status === "in_review" ? (
                      <div className="flex justify-end gap-1.5">
                        <Button size="xs" onClick={() => decide(r, "Approved")}>Approve</Button>
                        <Button size="xs" variant="destructive" onClick={() => decide(r, "Rejected")}>Reject</Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Closed</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
