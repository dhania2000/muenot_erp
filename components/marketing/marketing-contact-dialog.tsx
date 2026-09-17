"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { X } from "lucide-react"

export type OwnerOption = { id: number; name: string }

const STAGES = ["Subscriber", "Lead", "MQL", "SQL", "Opportunity", "Customer", "Evangelist", "Other"]
const SOURCES = ["Manual", "Import", "Website", "Event", "Referral", "Other"]
const SUBSCRIPTIONS = ["Subscribed", "Unsubscribed", "Pending"]

type FormState = {
  first_name: string
  last_name: string
  email: string
  phone: string
  company_name: string
  job_title: string
  source: string
  lifecycle_stage: string
  status: string
  owner_id: string
  email_subscription: string
  consent: boolean
  city: string
  state: string
  country: string
  notes: string
  tags: string[]
}

const EMPTY: FormState = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  company_name: "",
  job_title: "",
  source: "Manual",
  lifecycle_stage: "Subscriber",
  status: "Active",
  owner_id: "0",
  email_subscription: "Subscribed",
  consent: false,
  city: "",
  state: "",
  country: "",
  notes: "",
  tags: [],
}

export function ContactDialog({
  open,
  onOpenChange,
  owners,
  editing,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  owners: OwnerOption[]
  editing?: any | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [tagInput, setTagInput] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [duplicates, setDuplicates] = useState<any[]>([])

  useEffect(() => {
    if (!open) return
    setErrors({})
    setDuplicates([])
    setTagInput("")
    if (editing) {
      setForm({
        first_name: editing.first_name || "",
        last_name: editing.last_name || "",
        email: editing.email || "",
        phone: editing.phone || "",
        company_name: editing.company_name || "",
        job_title: editing.job_title || "",
        source: editing.source || "Manual",
        lifecycle_stage: editing.lifecycle_stage || "Subscriber",
        status: editing.status || "Active",
        owner_id: editing.owner_id ? String(editing.owner_id) : "0",
        email_subscription: editing.email_subscription || "Subscribed",
        consent: Boolean(editing.consent),
        city: editing.city || "",
        state: editing.state || "",
        country: editing.country || "",
        notes: editing.notes || "",
        tags: editing.tags || [],
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, editing])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function addTag() {
    const t = tagInput.trim()
    if (!t) return
    if (!form.tags.includes(t)) set("tags", [...form.tags, t])
    setTagInput("")
  }

  async function submit(force = false) {
    setSaving(true)
    setErrors({})
    const payload: any = {
      ...form,
      owner_id: form.owner_id === "0" ? null : Number(form.owner_id),
      force,
    }
    if (editing) payload.row_version = editing.row_version

    const url = editing ? `/api/marketing/contacts/${editing.id}` : "/api/marketing/contacts"
    const method = editing ? "PATCH" : "POST"
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    setSaving(false)

    if (res.status === 409 && data.duplicates) {
      setDuplicates(data.duplicates)
      return
    }
    if (res.status === 400 && data.fields) {
      setErrors(data.fields)
      toast.error("Please fix the highlighted fields")
      return
    }
    if (!res.ok) {
      toast.error(data.error || "Unable to save contact")
      return
    }
    toast.success(editing ? "Contact updated" : "Contact created")
    onOpenChange(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit contact" : "Add contact"}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update ${editing.contact_code}. Changes are tracked on the activity timeline.`
              : "Create a marketing contact. An email or phone number is required."}
          </DialogDescription>
        </DialogHeader>

        {duplicates.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium text-amber-600 dark:text-amber-400">Possible duplicate found</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {duplicates.map((d) => (
                <li key={d.id}>
                  {d.full_name} ({d.contact_code}) — {d.reason}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDuplicates([])}>
                Go back
              </Button>
              <Button size="sm" onClick={() => submit(true)} disabled={saving}>
                Create anyway
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" error={errors.first_name}>
            <Input value={form.first_name} onChange={(e) => set("first_name", e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={form.last_name} onChange={(e) => set("last_name", e.target.value)} />
          </Field>
          <Field label="Email" error={errors.email}>
            <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="Company">
            <Input value={form.company_name} onChange={(e) => set("company_name", e.target.value)} />
          </Field>
          <Field label="Job title">
            <Input value={form.job_title} onChange={(e) => set("job_title", e.target.value)} />
          </Field>

          <Field label="Lifecycle stage">
            <SelectBox value={form.lifecycle_stage} onChange={(v) => set("lifecycle_stage", v)} options={STAGES} />
          </Field>
          <Field label="Source">
            <SelectBox value={form.source} onChange={(v) => set("source", v)} options={SOURCES} />
          </Field>

          <Field label="Owner">
            <Select value={form.owner_id} onValueChange={(v) => set("owner_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Unassigned</SelectItem>
                {owners.map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Email subscription">
            <SelectBox
              value={form.email_subscription}
              onChange={(v) => set("email_subscription", v)}
              options={SUBSCRIPTIONS}
            />
          </Field>

          <Field label="City">
            <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
          <Field label="Country">
            <Input value={form.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Tags</Label>
          <div className="flex flex-wrap gap-1.5">
            {form.tags.map((t) => (
              <Badge key={t} variant="secondary" className="gap-1">
                {t}
                <button type="button" onClick={() => set("tags", form.tags.filter((x) => x !== t))}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Add a tag and press Enter"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  addTag()
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addTag}>
              Add
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Consent on record</p>
            <p className="text-xs text-muted-foreground">
              Confirms this contact opted in to marketing communications.
            </p>
          </div>
          <Switch checked={form.consent} onCheckedChange={(v) => set("consent", v)} />
        </div>

        <Field label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => submit(false)} disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Create contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  )
}

function SelectBox({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
