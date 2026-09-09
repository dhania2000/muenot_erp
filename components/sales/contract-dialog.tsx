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
import type { ContractRow } from "@/components/sales/contracts-client"

const STATUSES = ["Draft", "Active", "Expired", "Terminated"]

type FormState = {
  company_name: string
  start_date: string
  end_date: string
  value: string
  contract_type: string
  status: string
  signed_by_client: string
  signed_by_company: string
  notes: string
}

const EMPTY: FormState = {
  company_name: "",
  start_date: "",
  end_date: "",
  value: "",
  contract_type: "",
  status: "Draft",
  signed_by_client: "",
  signed_by_company: "",
  notes: "",
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

  useEffect(() => {
    if (!open) return
    setError(null)
    if (contract) {
      setForm({
        company_name: contract.company_name || "",
        start_date: toDateInputValue(contract.start_date),
        end_date: toDateInputValue(contract.end_date),
        value: String(contract.value ?? ""),
        contract_type: contract.contract_type || "",
        status: contract.status || "Draft",
        signed_by_client: contract.signed_by_client || "",
        signed_by_company: contract.signed_by_company || "",
        notes: contract.notes || "",
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

    const payload = { ...form, value: Number(form.value) }

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
              {contract ? "Update this contract's details." : "Add a new signed or draft contract."}
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
                  <FieldLabel htmlFor="contract_type">Contract type</FieldLabel>
                  <Input
                    id="contract_type"
                    placeholder="e.g. Annual, Retainer"
                    value={form.contract_type}
                    onChange={(e) => update("contract_type", e.target.value)}
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
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="end_date">End date</FieldLabel>
                  <Input
                    id="end_date"
                    type="date"
                    value={form.end_date}
                    onChange={(e) => update("end_date", e.target.value)}
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
                  />
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
                  <FieldLabel htmlFor="signed_by_client">Signed by (client)</FieldLabel>
                  <Input
                    id="signed_by_client"
                    value={form.signed_by_client}
                    onChange={(e) => update("signed_by_client", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="signed_by_company">Signed by (company)</FieldLabel>
                  <Input
                    id="signed_by_company"
                    value={form.signed_by_company}
                    onChange={(e) => update("signed_by_company", e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="notes">Notes</FieldLabel>
                <Textarea
                  id="notes"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => update("notes", e.target.value)}
                />
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
