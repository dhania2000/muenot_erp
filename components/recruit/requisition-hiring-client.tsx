"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, ClipboardList, ExternalLink, MoreHorizontal, Search } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"

type Requisition = {
  requisition_id: string
  job_title: string | null
  department: string | null
  location: string | null
  required_resources: number | null
  filled_resources: number | null
  priority: string | null
  hiring_manager: string | null
  approval_status: string
  approved_by_name: string | null
  linked_job_id: string | null
  linked_job_status: string | null
  hired_count: number
}

const APPROVAL_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_approval: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
}

const APPROVAL_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
}

export function RequisitionHiringClient({ canManage, canApprove }: { canManage: boolean; canApprove: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ requisitions: Requisition[]; migrationPending: boolean }>(
    "/api/recruit/requisitions",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const rows = data?.requisitions ?? []
  const migrationPending = data?.migrationPending

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.requisition_id, r.job_title, r.department, r.hiring_manager]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    )
  }, [rows, search])

  async function act(id: string, action: string, notes?: string) {
    const res = await fetch(`/api/recruit/requisitions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, notes }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      if (action === "create-job") toast.success(`Job ${json.job_id} created`)
      else toast.success("Requisition updated")
      mutate()
    } else {
      toast.error(json.error || "Action failed")
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Requisition Approvals & Hiring"
        description="Approve manpower requisitions and open jobs on the recruitment pipeline directly from an approved requisition."
        icon={ClipboardList}
      />

      {migrationPending && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          The recruitment integrations migration has not been applied yet. Run{" "}
          <code className="font-mono">database/migrations/2026-10-06-recruit-integrations.sql</code> to enable
          approvals and requisition-to-job linking.
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search requisitions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 pl-8"
        />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Requisition</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Headcount</TableHead>
              <TableHead>Approval</TableHead>
              <TableHead>Linked job</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  Loading requisitions...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No requisitions found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((r) => {
              const required = Number(r.required_resources) || 0
              const filled = r.linked_job_id ? Number(r.hired_count) || 0 : Number(r.filled_resources) || 0
              return (
                <TableRow key={r.requisition_id}>
                  <TableCell>
                    <div className="font-medium">{r.job_title || "Untitled role"}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.requisition_id}
                      {r.priority ? ` · ${r.priority}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.department || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {filled}/{required || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge className={APPROVAL_TONE[r.approval_status] || APPROVAL_TONE.draft}>
                      {APPROVAL_LABEL[r.approval_status] || r.approval_status}
                    </Badge>
                    {r.approved_by_name && (
                      <div className="mt-1 text-xs text-muted-foreground">by {r.approved_by_name}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.linked_job_id ? (
                      <Link
                        href={`/modules/recruitment/jobs/${r.linked_job_id}/edit`}
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        {r.linked_job_id} <ExternalLink className="size-3" />
                        <span className="text-xs text-muted-foreground">({r.linked_job_status || "open"})</span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canManage && (r.approval_status === "draft" || r.approval_status === "rejected") && (
                          <DropdownMenuItem onClick={() => act(r.requisition_id, "submit")}>
                            Submit for approval
                          </DropdownMenuItem>
                        )}
                        {canApprove && r.approval_status === "pending_approval" && (
                          <>
                            <DropdownMenuItem onClick={() => act(r.requisition_id, "approve")}>
                              Approve
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => act(r.requisition_id, "reject")}
                            >
                              Reject
                            </DropdownMenuItem>
                          </>
                        )}
                        {canManage && r.approval_status === "approved" && !r.linked_job_id && (
                          <DropdownMenuItem onClick={() => act(r.requisition_id, "create-job")}>
                            <CheckCircle2 className="size-4" /> Create job from requisition
                          </DropdownMenuItem>
                        )}
                        {canManage &&
                          (r.approval_status === "approved" || r.approval_status === "rejected") && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => act(r.requisition_id, "reset")}>
                                Reset to draft
                              </DropdownMenuItem>
                            </>
                          )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </main>
  )
}
