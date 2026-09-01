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
import type { CompanyRow } from "@/components/sales/companies-client"

const STATUSES = ["New", "Contacted", "Qualified", "Inactive"]
const PRIORITIES = ["Low", "Medium", "High"]

type FormState = {
  company_name: string
  industry: string
  website: string
  linkedin_url: string
  company_email: string
  country: string
  assigned_to: string
  company_type: string
  status: string
  priority: string
  founded_year: string
  employee_count: string
}

const EMPTY: FormState = {
  company_name: "",
  industry: "",
  website: "",
  linkedin_url: "",
  company_email: "",
  country: "",
  assigned_to: "",
  company_type: "",
  status: "New",
  priority: "",
  founded_year: "",
  employee_count: "",
}

export function CompanyDialog({
  open,
  onOpenChange,
  company,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  company: CompanyRow | null
  onSaved: () => void
}) {
  const { data } = useSWR<{ users: { id: number; name: string }[] }>("/api/sales/team", fetcher)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (company) {
      setForm({
        company_name: company.company_name || "",
        industry: company.industry || "",
        website: company.website || "",
        linkedin_url: company.linkedin_url || "",
        company_email: company.company_email || "",
        country: company.country || "",
        assigned_to: company.assigned_to ? String(company.assigned_to) : "",
        company_type: company.company_type || "",
        status: company.status || "New",
        priority: company.priority || "",
        founded_year: company.founded_year ? String(company.founded_year) : "",
        employee_count: company.employee_count ? String(company.employee_count) : "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, company])

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

    const payload = {
      ...form,
      assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
      founded_year: form.founded_year ? Number(form.founded_year) : null,
      employee_count: form.employee_count ? Number(form.employee_count) : null,
    }

    try {
      const res = await fetch(company ? `/api/sales/companies/${company.id}` : "/api/sales/companies", {
        method: company ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save company")
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
            <DialogTitle>{company ? "Edit company" : "Add company"}</DialogTitle>
            <DialogDescription>
              {company ? "Update this account's details." : "Add a target company to the account database."}
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
                  <Input id="industry" value={form.industry} onChange={(e) => update("industry", e.target.value)} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="website">Website</FieldLabel>
                  <Input id="website" value={form.website} onChange={(e) => update("website", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="linkedin_url">LinkedIn URL</FieldLabel>
                  <Input
                    id="linkedin_url"
                    value={form.linkedin_url}
                    onChange={(e) => update("linkedin_url", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="company_email">Company email</FieldLabel>
                  <Input
                    id="company_email"
                    type="email"
                    value={form.company_email}
                    onChange={(e) => update("company_email", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="country">Location</FieldLabel>
                  <Input id="country" value={form.country} onChange={(e) => update("country", e.target.value)} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="company_type">Company type</FieldLabel>
                  <Input
                    id="company_type"
                    placeholder="e.g. Prospect, Partner"
                    value={form.company_type}
                    onChange={(e) => update("company_type", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="priority">Priority</FieldLabel>
                  <Select value={form.priority || "none"} onValueChange={(v) => update("priority", v === "none" ? "" : v)}>
                    <SelectTrigger id="priority" className="w-full">
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">Unset</SelectItem>
                        {PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
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
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="founded_year">Founded year</FieldLabel>
                  <Input
                    id="founded_year"
                    type="number"
                    value={form.founded_year}
                    onChange={(e) => update("founded_year", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="employee_count">Employee count</FieldLabel>
                  <Input
                    id="employee_count"
                    type="number"
                    value={form.employee_count}
                    onChange={(e) => update("employee_count", e.target.value)}
                  />
                </Field>
              </div>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {company ? "Save changes" : "Add company"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
