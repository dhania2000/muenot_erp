"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { History } from "lucide-react"

function formatDate(value: unknown): string {
  if (!value) return "—"
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

/**
 * Read-only SOP version history (Phase 33). Snapshots are written automatically
 * by the Operations write path; this dialog surfaces the immutable history for a
 * single SOP so nothing is silently overwritten.
 */
export function OperationsSopHistory({ sopId, title }: { sopId: number | string; title?: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useSWR<{ rows: any[] }>(
    open ? `/api/operations/sop-versions?sop_id=${encodeURIComponent(String(sopId))}` : null,
    fetcher,
  )
  const rows = data?.rows ?? []

  return (
    <>
      <Button size="sm" variant="ghost" aria-label="View SOP version history" onClick={() => setOpen(true)}>
        <History className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Version History{title ? ` — ${title}` : ""}</DialogTitle>
            <DialogDescription>
              Immutable snapshots captured on every SOP create or update. Older versions are never overwritten.
            </DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Captured</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="p-6 text-center text-muted-foreground">
                    Loading history…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="p-6 text-center text-muted-foreground">
                    No version history yet. It will appear after the next save.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.version ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={r.change_type === "Created" ? "default" : "secondary"}>
                      {r.change_type ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.status ?? "—"}</TableCell>
                  <TableCell>{r.approval_status ?? "—"}</TableCell>
                  <TableCell>{r.owner ?? "—"}</TableCell>
                  <TableCell>{r.effective_date ? String(r.effective_date).slice(0, 10) : "—"}</TableCell>
                  <TableCell>{r.snapshot_by_name ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDate(r.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </>
  )
}
