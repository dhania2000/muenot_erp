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
import { toDateInputValue } from "@/lib/utils"
import type { QuotationRow } from "@/components/sales/quotations-client"

const STATUSES = ["Draft", "Sent", "Accepted", "Rejected", "Expired"]

type FormState = {
  company_name: string
  contact_person: string
  opportunity_name: string
  total_amount: string
  valid_until: string
  status: string
}

const EMPTY: FormState = {
  company_name: "",
  contact_person: "",
  opportunity_name: "",
  total_amount: "",
  valid_until: "",
  status: "Draft",
}

export function QuotationDialog({
  open,
  onOpenChange,
  quotation,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  quotation: QuotationRow | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (quotation) {
      setForm({
        company_name: quotation.company_name || "",
        contact_person: quotation.contact_person || "",
        opportunity_name: quotation.opportunity_name || "",
        total_amount: String(quotation.total_amount ?? ""),
        valid_until: toDateInputValue(quotation.valid_until),
        status: quotation.status || "Draft",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, quotation])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name || !form.total_amount) {
      setError("Company name and amount are required")
      return
    }
    setLoading(true)
    setError(null)

    const payload = { ...form, total_amount: Number(form.total_amount) }

    try {
      const res = await fetch(quotation ? `/api/sales/quotations/${quotation.id}` : "/api/sales/quotations", {
        method: quotation ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save quotation")
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
            <DialogTitle>{quotation ? "Edit quotation" : "Create quotation"}</DialogTitle>
            <DialogDescription>
              {quotation ? "Update this quotation's details." : "Create a quotation for a client."}
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
                  <FieldLabel htmlFor="company_name">Company</FieldLabel>
                  <Input
                    id="company_name"
                    value={form.company_name}
                    onChange={(e) => update("company_name", e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="contact_person">Contact person</FieldLabel>
                  <Input
                    id="contact_person"
                    value={form.contact_person}
                    onChange={(e) => update("contact_person", e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="opportunity_name">Opportunity name</FieldLabel>
                <Input
                  id="opportunity_name"
                  value={form.opportunity_name}
                  onChange={(e) => update("opportunity_name", e.target.value)}
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="total_amount">Total amount (INR)</FieldLabel>
                  <Input
                    id="total_amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.total_amount}
                    onChange={(e) => update("total_amount", e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="valid_until">Valid until</FieldLabel>
                  <Input
                    id="valid_until"
                    type="date"
                    value={form.valid_until}
                    onChange={(e) => update("valid_until", e.target.value)}
                  />
                </Field>
              </div>

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
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {quotation ? "Save changes" : "Create quotation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
