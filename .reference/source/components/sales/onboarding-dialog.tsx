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
import type { OnboardingRow } from "@/components/sales/onboarding-client"

const STAGES = ["Kickoff", "Setup", "Training", "Integration", "Completed"]
const STATUSES = ["Not Started", "In Progress", "Completed", "On Hold"]

type FormState = {
  company_name: string
  contract_code: string
  start_date: string
  kickoff_meeting_date: string
  current_stage: string
  status: string
  onboarding_by: string
}

const EMPTY: FormState = {
  company_name: "",
  contract_code: "",
  start_date: "",
  kickoff_meeting_date: "",
  current_stage: "Kickoff",
  status: "Not Started",
  onboarding_by: "",
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
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (record) {
      setForm({
        company_name: record.company_name || "",
        contract_code: record.contract_code || "",
        start_date: toDateInputValue(record.start_date),
        kickoff_meeting_date: toDateInputValue(record.kickoff_meeting_date),
        current_stage: record.current_stage || "Kickoff",
        status: record.status || "Not Started",
        onboarding_by: record.onboarding_by || "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, record])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name) {
      setError("Company name is required")
      return
    }
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(record ? `/api/sales/onboarding/${record.id}` : "/api/sales/onboarding", {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{record ? "Edit onboarding" : "Add onboarding record"}</DialogTitle>
            <DialogDescription>
              {record ? "Update this client's onboarding progress." : "Track a new client's onboarding journey."}
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
                  <FieldLabel htmlFor="contract_code">Contract code</FieldLabel>
                  <Input
                    id="contract_code"
                    placeholder="e.g. CT-004"
                    value={form.contract_code}
                    onChange={(e) => update("contract_code", e.target.value)}
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
                  <FieldLabel htmlFor="kickoff_meeting_date">Kickoff meeting date</FieldLabel>
                  <Input
                    id="kickoff_meeting_date"
                    type="date"
                    value={form.kickoff_meeting_date}
                    onChange={(e) => update("kickoff_meeting_date", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="current_stage">Current stage</FieldLabel>
                  <Select value={form.current_stage} onValueChange={(v) => update("current_stage", v)}>
                    <SelectTrigger id="current_stage" className="w-full">
                      <SelectValue placeholder="Select stage" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {STAGES.map((s) => (
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

              <Field>
                <FieldLabel htmlFor="onboarding_by">Onboarding lead</FieldLabel>
                <Input
                  id="onboarding_by"
                  placeholder="Name of person leading onboarding"
                  value={form.onboarding_by}
                  onChange={(e) => update("onboarding_by", e.target.value)}
                />
              </Field>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {record ? "Save changes" : "Add onboarding"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
