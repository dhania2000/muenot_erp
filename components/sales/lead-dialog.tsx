"use client"

import { useActionState, useEffect } from "react"
import { toast } from "sonner"
import { saveLead, type LeadFormState } from "@/app/actions/leads"
import type { Lead } from "@/lib/sales"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const STATUS_OPTIONS = ["New", "Contacted", "In Discussion", "Proposal Sent", "Negotiation", "Won", "Lost", "On Hold"]

export function LeadDialog({
  open,
  onOpenChange,
  lead,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  lead: Lead | null
}) {
  const [state, action, pending] = useActionState<LeadFormState, FormData>(saveLead, {})

  useEffect(() => {
    if (state.ok) {
      toast.success(lead ? "Lead updated" : "Lead created")
      onOpenChange(false)
    } else if (state.error) {
      toast.error(state.error)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{lead ? "Edit lead" : "New lead"}</DialogTitle>
          <DialogDescription>
            {lead ? `Update the details for ${lead.company_name ?? "this lead"}.` : "Add a new lead to the pipeline."}
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="grid gap-4 sm:grid-cols-2">
          {lead ? <input type="hidden" name="id" value={lead.id} /> : null}

          <Field label="Contact person" name="contact_person" defaultValue={lead?.contact_person} />
          <Field label="Designation" name="designation" defaultValue={lead?.designation} />
          <Field label="Email" name="email" type="email" defaultValue={lead?.email} />
          <Field label="Contact number" name="contact_number" defaultValue={lead?.contact_number} />
          <Field label="Company name" name="company_name" defaultValue={lead?.company_name} />
          <Field label="Industry" name="industry" defaultValue={lead?.industry} />
          <Field label="Country" name="country" defaultValue={lead?.country} />
          <Field label="Lead source" name="lead_source" defaultValue={lead?.lead_source} />
          <Field label="Assigned to" name="assigned_to" defaultValue={lead?.assigned_to} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={lead?.status ?? "New"}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <Field label="Follow-up date" name="follow_up_date" type="date" defaultValue={lead?.follow_up_date ?? undefined} />
          <Field
            label="Health score (0–100)"
            name="health_score"
            type="number"
            defaultValue={lead?.health_score != null ? String(lead.health_score) : undefined}
          />

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="remarks">Remarks</Label>
            <Textarea id="remarks" name="remarks" defaultValue={lead?.remarks ?? ""} rows={3} />
          </div>

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : lead ? "Save changes" : "Create lead"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
}: {
  label: string
  name: string
  type?: string
  defaultValue?: string | null
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue ?? undefined} />
    </div>
  )
}
