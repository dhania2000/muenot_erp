"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2Icon } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { toDateInputValue } from "@/lib/utils"
import type { LeadRow } from "@/components/sales/leads-client"

const STATUSES = ["New", "Follow Up 1", "Follow Up 2", "In Discussion", "Proposal Sent", "Ready", "Won", "Lost"]
const SOURCES = ["Website", "LinkedIn", "Referral", "Cold Outreach", "Event", "Other"]

type FormState = {
  lead_date: string
  contact_person: string
  contact_number: string
  email: string
  designation: string
  lead_source: string
  company_name: string
  industry: string
  website: string
  company_email: string
  country: string
  assigned_to: string
  status: string
  follow_up_date: string
  remarks: string
}

const EMPTY: FormState = {
  lead_date: "",
  contact_person: "",
  contact_number: "",
  email: "",
  designation: "",
  lead_source: "",
  company_name: "",
  industry: "",
  website: "",
  company_email: "",
  country: "",
  assigned_to: "",
  status: "New",
  follow_up_date: "",
  remarks: "",
}

export function LeadDialog({
  open,
  onOpenChange,
  lead,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  lead: LeadRow | null
  onSaved: () => void
}) {
  const { data } = useSWR<{ users: { id: number; name: string }[] }>("/api/sales/team", fetcher)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (lead) {
      setForm({
        lead_date: toDateInputValue(lead.lead_date),
        contact_person: lead.contact_person || "",
        contact_number: lead.contact_number || "",
        email: lead.email || "",
        designation: lead.designation || "",
        lead_source: lead.lead_source || "",
        company_name: lead.company_name || "",
        industry: lead.industry || "",
        website: lead.website || "",
        company_email: lead.company_email || "",
        country: lead.country || "",
        assigned_to: lead.assigned_to ? String(lead.assigned_to) : "",
        status: lead.status || "New",
        follow_up_date: toDateInputValue(lead.follow_up_date),
        remarks: lead.remarks || "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, lead])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.contact_person || !form.company_name) {
      setError("Contact person and company name are required")
      return
    }
    setLoading(true)
    setError(null)

    const payload = {
      ...form,
      assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
    }

    try {
      const res = await fetch(lead ? `/api/sales/leads/${lead.id}` : "/api/sales/leads", {
        method: lead ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save lead")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{lead ? "Edit lead" : "Add lead"}</DialogTitle>
            <DialogDescription>
              {lead ? "Update the details for this lead." : "Capture a new lead in the pipeline."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="contact_person">Contact person</FieldLabel>
                  <Input
                    id="contact_person"
                    value={form.contact_person}
                    onChange={(e) => update("contact_person", e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="designation">Designation</FieldLabel>
                  <Input
                    id="designation"
                    value={form.designation}
                    onChange={(e) => update("designation", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => update("email", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="contact_number">Phone</FieldLabel>
                  <Input
                    id="contact_number"
                    value={form.contact_number}
                    onChange={(e) => update("contact_number", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="company_name">Company name</FieldLabel>
                  <Input
                    id="company_name"
                    value={form.company_name}
                    onChange={(e) => update("company_name", e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="industry">Industry</FieldLabel>
                  <Input
                    id="industry"
                    value={form.industry}
                    onChange={(e) => update("industry", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="website">Website</FieldLabel>
                  <Input
                    id="website"
                    value={form.website}
                    onChange={(e) => update("website", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="country">Country</FieldLabel>
                  <Input
                    id="country"
                    value={form.country}
                    onChange={(e) => update("country", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="lead_source">Lead source</FieldLabel>
                  <Select value={form.lead_source} onValueChange={(v) => update("lead_source", v)}>
                    <SelectTrigger id="lead_source" className="w-full">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {SOURCES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="status">Status</FieldLabel>
                  <Select value={form.status} onValueChange={(v) => update("status", v)}>
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="assigned_to">Assigned to</FieldLabel>
                  <Select
                    value={form.assigned_to || "unassigned"}
                    onValueChange={(v) => update("assigned_to", v === "unassigned" ? "" : v)}
                  >
                    <SelectTrigger id="assigned_to" className="w-full">
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        {data?.users.map((u) => (
                          <SelectItem key={u.id} value={String(u.id)}>
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="follow_up_date">Follow-up date</FieldLabel>
                  <Input
                    id="follow_up_date"
                    type="date"
                    value={form.follow_up_date}
                    onChange={(e) => update("follow_up_date", e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="remarks">Remarks</FieldLabel>
                <Textarea
                  id="remarks"
                  rows={3}
                  value={form.remarks}
                  onChange={(e) => update("remarks", e.target.value)}
                />
              </Field>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {lead ? "Save changes" : "Add lead"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
