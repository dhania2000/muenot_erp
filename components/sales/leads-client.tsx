"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import type { Lead } from "@/lib/sales"
import { deleteLead } from "@/app/actions/leads"
import { StatusBadge } from "@/components/status-badge"
import { LeadDialog } from "@/components/sales/lead-dialog"
import { EmptyState } from "@/components/states"
import { formatDate } from "@/lib/format"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Plus, Pencil, Trash2, TriangleAlert } from "lucide-react"

export function LeadsClient({ leads, canEdit }: { leads: Lead[]; canEdit: boolean }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Lead | null>(null)
  const [toDelete, setToDelete] = useState<Lead | null>(null)
  const [pending, startTransition] = useTransition()

  function openNew() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(lead: Lead) {
    setEditing(lead)
    setDialogOpen(true)
  }
  function confirmDelete() {
    if (!toDelete) return
    startTransition(async () => {
      try {
        await deleteLead(toDelete.id)
        toast.success("Lead deleted")
      } catch (e: any) {
        toast.error(e?.message ?? "Failed to delete")
      }
      setToDelete(null)
    })
  }

  return (
    <>
      {canEdit ? (
        <Button size="sm" onClick={openNew} className="gap-1.5">
          <Plus className="size-4" />
          New lead
        </Button>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Lead</th>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium">Owner</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Follow-up</th>
                <th className="px-4 py-2.5 text-right font-medium">Health</th>
                {canEdit ? <th className="px-4 py-2.5 text-right font-medium">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const overdue = (lead.sla_gap_days ?? 0) > 0
                return (
                  <tr key={lead.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{lead.contact_person ?? "—"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{lead.lead_code}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div>{lead.company_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{lead.industry ?? ""}</div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{lead.assigned_to ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={lead.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {overdue ? <TriangleAlert className="size-3.5 text-destructive" /> : null}
                        <span className={overdue ? "text-destructive" : "text-muted-foreground"}>
                          {formatDate(lead.follow_up_date)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {lead.health_score ?? "—"}
                    </td>
                    {canEdit ? (
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => openEdit(lead)}>
                            <Pencil className="size-3.5" />
                            <span className="sr-only">Edit</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setToDelete(lead)}
                          >
                            <Trash2 className="size-3.5" />
                            <span className="sr-only">Delete</span>
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {leads.length === 0 ? <EmptyState message="No leads match your filters." /> : null}
      </div>

      <LeadDialog open={dialogOpen} onOpenChange={setDialogOpen} lead={editing} />

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lead?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {toDelete?.contact_person ?? "this lead"}
              {toDelete?.company_name ? ` from ${toDelete.company_name}` : ""}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                confirmDelete()
              }}
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
