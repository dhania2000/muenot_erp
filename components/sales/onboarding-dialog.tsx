"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
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
import { toDateInputValue, formatCurrency } from "@/lib/utils"
import { EntityCombobox, type ComboOption } from "@/components/sales/entity-combobox"
import { ONBOARDING_STAGES, ONBOARDING_STATUSES, ONBOARDING_PRIORITIES } from "@/components/sales/onboarding-constants"
import type { OnboardingRow } from "@/components/sales/onboarding-client"

type Lookups = {
  companies: any[]
  contracts: any[]
  quotations: any[]
  leads: any[]
  contacts: any[]
  users: any[]
  templates: any[]
}

type FormState = {
  company_id: string | null
  contact_id: string | null
  contract_id: string | null
  quotation_id: string | null
  lead_id: string | null
  owner_id: string | null
  template_id: string | null
  onboarding_date: string
  start_date: string
  target_completion_date: string
  kickoff_meeting_date: string
  priority: string
  current_stage: string
  status: string
  requirements_summary: string
  scope_notes: string
  internal_notes: string
}

function emptyForm(): FormState {
  return {
    company_id: null,
    contact_id: null,
    contract_id: null,
    quotation_id: null,
    lead_id: null,
    owner_id: null,
    template_id: null,
    onboarding_date: toDateInputValue(new Date()),
    start_date: "",
    target_completion_date: "",
    kickoff_meeting_date: "",
    priority: "Medium",
    current_stage: "Planning",
    status: "Not Started",
    requirements_summary: "",
    scope_notes: "",
    internal_notes: "",
  }
}

export function OnboardingDialog({
  open,
  onOpenChange,
  record,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  record: OnboardingRow | null
  onSaved: () => void
}) {
  const { data: lookups } = useSWR<Lookups>(open ? "/api/sales/onboarding/lookups" : null, fetcher)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (record) {
      setForm({
        company_id: record.company_id ? String(record.company_id) : null,
        contact_id: record.contact_id ? String(record.contact_id) : null,
        contract_id: record.contract_id ? String(record.contract_id) : null,
        quotation_id: record.quotation_id ? String(record.quotation_id) : null,
        lead_id: record.lead_id ? String(record.lead_id) : null,
        owner_id: record.owner_id ? String(record.owner_id) : null,
        template_id: null,
        onboarding_date: toDateInputValue(record.onboarding_date),
        start_date: toDateInputValue(record.start_date),
        target_completion_date: toDateInputValue(record.target_completion_date),
        kickoff_meeting_date: toDateInputValue(record.kickoff_meeting_date),
        priority: record.priority || "Medium",
        current_stage: record.current_stage || "Planning",
        status: record.status || "Not Started",
        requirements_summary: record.requirements_summary || "",
        scope_notes: record.scope_notes || "",
        internal_notes: record.internal_notes || "",
      })
    } else {
      setForm(emptyForm())
    }
  }, [open, record])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const companyOpts: ComboOption[] = useMemo(
    () =>
      (lookups?.companies || []).map((c) => ({
        value: String(c.id),
        label: c.company_name || c.company_code || `Company ${c.id}`,
        hint: [c.company_code, c.industry].filter(Boolean).join(" · ") || null,
      })),
    [lookups],
  )
  const contractOpts: ComboOption[] = useMemo(
    () =>
      (lookups?.contracts || []).map((c) => ({
        value: String(c.id),
        label: c.contract_code || `Contract ${c.id}`,
        hint: [c.company_name, c.contract_value ? formatCurrency(Number(c.contract_value)) : null].filter(Boolean).join(" · ") || null,
      })),
    [lookups],
  )
  const quotationOpts: ComboOption[] = useMemo(
    () =>
      (lookups?.quotations || []).map((q) => ({
        value: String(q.id),
        label: q.quote_code || `Quotation ${q.id}`,
        hint: q.company_name || null,
      })),
    [lookups],
  )
  const leadOpts: ComboOption[] = useMemo(
    () =>
      (lookups?.leads || []).map((l) => ({
        value: String(l.id),
        label: l.lead_code || `Lead ${l.id}`,
        hint: [l.company_name, l.contact_person].filter(Boolean).join(" · ") || null,
      })),
    [lookups],
  )
  const ownerOpts: ComboOption[] = useMemo(
    () => (lookups?.users || []).map((u) => ({ value: String(u.id), label: u.name })),
    [lookups],
  )
  const contactOpts: ComboOption[] = useMemo(() => {
    const all = lookups?.contacts || []
    const scoped = form.company_id ? all.filter((c) => String(c.company_id) === form.company_id) : all
    return scoped.map((c) => ({ value: String(c.id), label: c.name, hint: c.is_primary ? "Primary contact" : null }))
  }, [lookups, form.company_id])

  const selectedContract = useMemo(
    () => (lookups?.contracts || []).find((c) => String(c.id) === form.contract_id) || null,
    [lookups, form.contract_id],
  )

  /** Selecting a contract auto-fills company / quotation / owner from the master. */
  function onContractChange(value: string | null) {
    setForm((prev) => {
      const next = { ...prev, contract_id: value }
      if (value) {
        const c = (lookups?.contracts || []).find((x) => String(x.id) === value)
        if (c) {
          if (c.company_id) next.company_id = String(c.company_id)
          if (c.source_quotation_id) next.quotation_id = String(c.source_quotation_id)
          if (!prev.owner_id && c.owner_id) next.owner_id = String(c.owner_id)
          if (!prev.start_date && c.start_date) next.start_date = toDateInputValue(c.start_date)
        }
      }
      return next
    })
  }

  /** Changing company clears a contact that no longer belongs to it. */
  function onCompanyChange(value: string | null) {
    setForm((prev) => {
      const next = { ...prev, company_id: value }
      if (prev.contact_id) {
        const ct = (lookups?.contacts || []).find((c) => String(c.id) === prev.contact_id)
        if (ct && value && String(ct.company_id) !== value) next.contact_id = null
      }
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_id && !form.contract_id) {
      setError("Select a company or a contract to start onboarding.")
      return
    }
    setLoading(true)
    setError(null)

    const payload: Record<string, any> = {
      company_id: form.company_id ? Number(form.company_id) : null,
      contact_id: form.contact_id ? Number(form.contact_id) : null,
      contract_id: form.contract_id ? Number(form.contract_id) : null,
      quotation_id: form.quotation_id ? Number(form.quotation_id) : null,
      lead_id: form.lead_id ? Number(form.lead_id) : null,
      owner_id: form.owner_id ? Number(form.owner_id) : null,
      onboarding_date: form.onboarding_date || null,
      start_date: form.start_date || null,
      target_completion_date: form.target_completion_date || null,
      kickoff_meeting_date: form.kickoff_meeting_date || null,
      priority: form.priority,
      current_stage: form.current_stage,
      status: form.status,
      requirements_summary: form.requirements_summary || null,
      scope_notes: form.scope_notes || null,
      internal_notes: form.internal_notes || null,
    }
    if (!record) payload.template_id = form.template_id ? Number(form.template_id) : null
    if (record) payload.expectedRowVersion = record.row_version

    try {
      const res = await fetch(record ? `/api/sales/onboarding/${record.id}` : "/api/sales/onboarding", {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save onboarding record")
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
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{record ? "Edit onboarding" : "New client onboarding"}</DialogTitle>
            <DialogDescription>
              {record
                ? "Update the relational links and lifecycle plan for this implementation."
                : "Link the accepted contract or client company — related records are resolved automatically."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Contract</FieldLabel>
                  <EntityCombobox
                    options={contractOpts}
                    value={form.contract_id}
                    onChange={onContractChange}
                    placeholder="Link a signed contract"
                  />
                </Field>
                <Field>
                  <FieldLabel>Company</FieldLabel>
                  <EntityCombobox
                    options={companyOpts}
                    value={form.company_id}
                    onChange={onCompanyChange}
                    placeholder="Select company"
                  />
                </Field>
              </div>

              {selectedContract && (
                <p className="-mt-1 text-xs text-muted-foreground">
                  {"Contract "}
                  {selectedContract.contract_code}
                  {selectedContract.contract_value
                    ? ` · ${formatCurrency(Number(selectedContract.contract_value))}`
                    : ""}
                  {selectedContract.contract_type ? ` · ${selectedContract.contract_type}` : ""}
                </p>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Primary contact</FieldLabel>
                  <EntityCombobox
                    options={contactOpts}
                    value={form.contact_id}
                    onChange={(v) => update("contact_id", v)}
                    placeholder={form.company_id ? "Select contact" : "Select a company first"}
                    disabled={!form.company_id && contactOpts.length === 0}
                  />
                </Field>
                <Field>
                  <FieldLabel>Owner</FieldLabel>
                  <EntityCombobox
                    options={ownerOpts}
                    value={form.owner_id}
                    onChange={(v) => update("owner_id", v)}
                    placeholder="Implementation owner"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Source quotation</FieldLabel>
                  <EntityCombobox
                    options={quotationOpts}
                    value={form.quotation_id}
                    onChange={(v) => update("quotation_id", v)}
                    placeholder="Optional"
                  />
                </Field>
                <Field>
                  <FieldLabel>Source lead</FieldLabel>
                  <EntityCombobox
                    options={leadOpts}
                    value={form.lead_id}
                    onChange={(v) => update("lead_id", v)}
                    placeholder="Optional"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor="onboarding_date">Onboarding date</FieldLabel>
                  <Input
                    id="onboarding_date"
                    type="date"
                    value={form.onboarding_date}
                    onChange={(e) => update("onboarding_date", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="start_date">Start date</FieldLabel>
                  <Input
                    id="start_date"
                    type="date"
                    value={form.start_date}
                    onChange={(e) => update("start_date", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="target_completion_date">Target completion</FieldLabel>
                  <Input
                    id="target_completion_date"
                    type="date"
                    value={form.target_completion_date}
                    onChange={(e) => update("target_completion_date", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="kickoff_meeting_date">Kickoff date</FieldLabel>
                  <Input
                    id="kickoff_meeting_date"
                    type="date"
                    value={form.kickoff_meeting_date}
                    onChange={(e) => update("kickoff_meeting_date", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="current_stage">Stage</FieldLabel>
                  <Select value={form.current_stage} onValueChange={(v) => update("current_stage", v ?? "")}>
                    <SelectTrigger id="current_stage" className="w-full">
                      <SelectValue placeholder="Stage" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {ONBOARDING_STAGES.map((s) => (
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
                  <Select value={form.status} onValueChange={(v) => update("status", v ?? "")}>
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {ONBOARDING_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="priority">Priority</FieldLabel>
                  <Select value={form.priority} onValueChange={(v) => update("priority", v ?? "")}>
                    <SelectTrigger id="priority" className="w-full">
                      <SelectValue placeholder="Priority" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {ONBOARDING_PRIORITIES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              {!record && (
                <Field>
                  <FieldLabel htmlFor="template_id">Onboarding template</FieldLabel>
                  <Select value={form.template_id ?? ""} onValueChange={(v) => update("template_id", v || null)}>
                    <SelectTrigger id="template_id" className="w-full">
                      <SelectValue placeholder="None — start empty" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(lookups?.templates || []).map((t) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Seeds the checklist, documents and milestones for this implementation.
                  </p>
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="requirements_summary">Requirements summary</FieldLabel>
                <Textarea
                  id="requirements_summary"
                  rows={2}
                  value={form.requirements_summary}
                  onChange={(e) => update("requirements_summary", e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="scope_notes">Scope / delivery notes</FieldLabel>
                <Textarea
                  id="scope_notes"
                  rows={2}
                  value={form.scope_notes}
                  onChange={(e) => update("scope_notes", e.target.value)}
                />
              </Field>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {record ? "Save changes" : "Create onboarding"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
