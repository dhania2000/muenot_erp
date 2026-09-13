"use client"

import { useEffect, useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2Icon } from "lucide-react"
import { toDateInputValue } from "@/lib/utils"
import type { ContractRow } from "@/components/sales/contracts-client"

type FormState = {
  title: string
  company_name: string
  start_date: string
  end_date: string
  value: string
  contract_type: string
  signed_by_client: string
  signed_by_company: string
  terms: string
  notes: string
  auto_renew: boolean
  renewal_term_months: string
  notice_period_days: string
}

const EMPTY: FormState = {
  title: "",
  company_name: "",
  start_date: "",
  end_date: "",
  value: "",
  contract_type: "",
  signed_by_client: "",
  signed_by_company: "",
  terms: "",
  notes: "",
  auto_renew: false,
  renewal_term_months: "",
  notice_period_days: "",
}

export function ContractDialog({
  open,
  onOpenChange,
  contract,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contract: ContractRow | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Once a contract is Active/closed its commercial terms are locked server-side.
  const locked = !!contract && !["Draft", "Pending Signature"].includes(contract.status)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (contract) {
      setForm({
        title: contract.title || "",
        company_name: contract.company_name || "",
        start_date: toDateInputValue(contract.start_date),
        end_date: toDateInputValue(contract.end_date),
        value: String(contract.value ?? ""),
        contract_type: contract.contract_type || "",
        signed_by_client: contract.signed_by_client || "",
        signed_by_company: contract.signed_by_company || "",
        terms: contract.terms || "",
        notes: contract.notes || "",
        auto_renew: !!contract.auto_renew,
        renewal_term_months: contract.renewal_term_months ? String(contract.renewal_term_months) : "",
        notice_period_days: contract.notice_period_days ? String(contract.notice_period_days) : "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, contract])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name || !form.value) {
      setError("Company name and value are required")
      return
    }
    setLoading(true)
    setError(null)

    const payload: Record<string, any> = {
      ...form,
      value: Number(form.value),
      renewal_term_months: form.renewal_term_months ? Number(form.renewal_term_months) : null,
      notice_period_days: form.notice_period_days ? Number(form.notice_period_days) : null,
    }
    if (contract) payload.row_version = contract.row_version

    try {
      const res = await fetch(contract ? `/api/sales/contracts/${contract.id}` : "/api/sales/contracts", {
        method: contract ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save contract")
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
            <DialogTitle>{contract ? "Edit contract" : "Create contract"}</DialogTitle>
            <DialogDescription>
              {contract ? "Update this contract's details." : "Draft a new contract. It starts in Draft status."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {locked && (
              <Alert>
                <AlertDescription>
                  This {contract?.status} contract&apos;s terms are locked. You can still update notes and renewal
                  settings.
                </AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="title">Title</FieldLabel>
                <Input
                  id="title"
                  placeholder="e.g. Annual Services Agreement"
                  value={form.title}
                  onChange={(e) => update("title", e.target.value)}
                  disabled={locked}
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="company_name">Company</FieldLabel>
                  <Input
                    id="company_name"
                    value={form.company_name}
                    onChange={(e) => update("company_name", e.target.value)}
                    required
                    disabled={locked}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="contract_type">Contract type</FieldLabel>
                  <Input
                    id="contract_type"
                    placeholder="e.g. Annual, Retainer"
                    value={form.contract_type}
                    onChange={(e) => update("contract_type", e.target.value)}
                    disabled={locked}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="start_date">Start date</FieldLabel>
                  <Input
                    id="start_date"
                    type="date"
                    value={form.start_date}
                    onChange={(e) => update("start_date", e.target.value)}
                    disabled={locked}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="end_date">End date</FieldLabel>
                  <Input
                    id="end_date"
                    type="date"
                    value={form.end_date}
                    onChange={(e) => update("end_date", e.target.value)}
                    disabled={locked}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="value">Contract value (INR)</FieldLabel>
                  <Input
                    id="value"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.value}
                    onChange={(e) => update("value", e.target.value)}
                    required
                    disabled={locked}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="notice_period_days">Notice period (days)</FieldLabel>
                  <Input
                    id="notice_period_days"
                    type="number"
                    min="0"
                    value={form.notice_period_days}
                    onChange={(e) => update("notice_period_days", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="signed_by_client">Signatory (client)</FieldLabel>
                  <Input
                    id="signed_by_client"
                    value={form.signed_by_client}
                    onChange={(e) => update("signed_by_client", e.target.value)}
                    disabled={locked}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="signed_by_company">Signatory (company)</FieldLabel>
                  <Input
                    id="signed_by_company"
                    value={form.signed_by_company}
                    onChange={(e) => update("signed_by_company", e.target.value)}
                    disabled={locked}
                  />
                </Field>
              </div>

              <div className="flex items-center gap-3 rounded-md border border-border p-3">
                <Checkbox
                  id="auto_renew"
                  checked={form.auto_renew}
                  onCheckedChange={(v) => update("auto_renew", !!v)}
                />
                <div className="flex-1">
                  <FieldLabel htmlFor="auto_renew" className="cursor-pointer">
                    Auto-renew on expiry
                  </FieldLabel>
                </div>
                <Input
                  aria-label="Renewal term in months"
                  type="number"
                  min="1"
                  placeholder="Term (months)"
                  className="w-36"
                  value={form.renewal_term_months}
                  onChange={(e) => update("renewal_term_months", e.target.value)}
                />
              </div>

              <Field>
                <FieldLabel htmlFor="terms">Terms &amp; conditions</FieldLabel>
                <Textarea
                  id="terms"
                  rows={4}
                  placeholder="Contract terms rendered into the PDF..."
                  value={form.terms}
                  onChange={(e) => update("terms", e.target.value)}
                  disabled={locked}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="notes">Notes</FieldLabel>
                <Textarea id="notes" rows={2} value={form.notes} onChange={(e) => update("notes", e.target.value)} />
              </Field>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {contract ? "Save changes" : "Create contract"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
