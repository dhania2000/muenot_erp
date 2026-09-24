"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Plus, Trash2 } from "lucide-react"

export type ContactAddress = {
  id?: number
  label: string
  line1: string
  line2?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string | null
  is_primary?: boolean
}

export type ContactChannel = {
  id?: number
  type: string
  value: string
  label?: string | null
}

export type ContactRow = {
  id: number
  contact_code: string
  contact_type: "Person" | "Company"
  full_name: string
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  role?: string | null
  department?: string | null
  email?: string | null
  phone?: string | null
  is_customer?: boolean
  is_vendor?: boolean
  notes?: string | null
  row_version?: number
  client_id?: number | null
  finance_party_id?: string | null
  sales_company_id?: number | null
  sales_contact_id?: number | null
  marketing_contact_id?: number | null
  channels?: ContactChannel[]
  addresses?: ContactAddress[]
}

type DuplicateMatch = {
  id: number
  contact_code: string
  full_name: string
  company_name: string | null
  email: string | null
  phone: string | null
  reason: string
}

const CHANNEL_TYPES = ["LinkedIn", "Twitter/X", "WhatsApp", "Website", "Telegram", "Other"]
const ADDRESS_LABELS = ["Billing", "Shipping", "Office", "Home", "Other"]

const emptyChannel = (): ContactChannel => ({ type: "LinkedIn", value: "", label: "" })
const emptyAddress = (): ContactAddress => ({
  label: "Office",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postal_code: "",
  country: "",
  is_primary: false,
})

export function ContactDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contact: ContactRow | null
  onSaved: () => void
}) {
  const [contactType, setContactType] = useState<"Person" | "Company">("Person")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [companyName, setCompanyName] = useState("")
  const [role, setRole] = useState("")
  const [department, setDepartment] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [isCustomer, setIsCustomer] = useState(false)
  const [isVendor, setIsVendor] = useState(false)
  const [notes, setNotes] = useState("")
  const [channels, setChannels] = useState<ContactChannel[]>([])
  const [addresses, setAddresses] = useState<ContactAddress[]>([])

  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null)

  useEffect(() => {
    if (!open) return
    setFieldErrors({})
    setDupes(null)
    setContactType(contact?.contact_type ?? "Person")
    setFirstName(contact?.first_name ?? "")
    setLastName(contact?.last_name ?? "")
    setCompanyName(contact?.company_name ?? "")
    setRole(contact?.role ?? "")
    setDepartment(contact?.department ?? "")
    setEmail(contact?.email ?? "")
    setPhone(contact?.phone ?? "")
    setIsCustomer(!!contact?.is_customer)
    setIsVendor(!!contact?.is_vendor)
    setNotes(contact?.notes ?? "")
    setChannels(contact?.channels?.length ? contact.channels.map((c) => ({ ...c })) : [])
    setAddresses(contact?.addresses?.length ? contact.addresses.map((a) => ({ ...a })) : [])
  }, [open, contact])

  const derivedName = useMemo(() => {
    if (contactType === "Company") return companyName.trim()
    return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ")
  }, [contactType, companyName, firstName, lastName])

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (contactType === "Company") {
      if (!companyName.trim()) errs.companyName = "Company name is required"
    } else if (!firstName.trim()) {
      errs.firstName = "First name is required"
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = "Enter a valid email address"
    }
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) {
      toast.error("Please fix the highlighted fields")
      return false
    }
    return true
  }

  function buildPayload(force: boolean) {
    return {
      contact_type: contactType,
      first_name: contactType === "Person" ? firstName.trim() : null,
      last_name: contactType === "Person" ? lastName.trim() : null,
      company_name: companyName.trim() || null,
      full_name: derivedName,
      role: role.trim() || null,
      department: department.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      is_customer: isCustomer,
      is_vendor: isVendor,
      notes: notes.trim() || null,
      channels: channels.filter((c) => c.value.trim()).map((c) => ({ ...c, value: c.value.trim() })),
      addresses: addresses.filter((a) => a.line1.trim()),
      ...(force ? { force: true } : {}),
      ...(contact?.row_version != null ? { row_version: contact.row_version } : {}),
    }
  }

  async function submit(force: boolean) {
    if (!force && !validate()) return
    setSaving(true)
    const res = await fetch(contact ? `/api/contacts/${contact.id}` : "/api/contacts", {
      method: contact ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(force)),
    })
    setSaving(false)
    const data = await res.json().catch(() => ({}) as any)

    if (res.ok) {
      setDupes(null)
      toast.success(contact ? "Contact updated" : "Contact created")
      onOpenChange(false)
      onSaved()
      return
    }
    if (res.status === 400 && data.fields) {
      setFieldErrors(data.fields)
      toast.error("Please fix the highlighted fields")
      return
    }
    if (res.status === 409 && data.duplicates) {
      setDupes(data.duplicates)
      return
    }
    toast.error(data.error || "Unable to save contact")
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit(false)
            }}
            className="grid gap-6"
          >
            {/* Identity */}
            <section className="grid gap-4">
              <div className="grid gap-2">
                <Label>Contact type</Label>
                <Select value={contactType} onValueChange={(v) => setContactType(v as "Person" | "Company")}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Person">Person</SelectItem>
                    <SelectItem value="Company">Company</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {contactType === "Person" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name *" error={fieldErrors.firstName}>
                    <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} aria-invalid={!!fieldErrors.firstName} />
                  </Field>
                  <Field label="Last name">
                    <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </Field>
                  <Field label="Company">
                    <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                  </Field>
                  <Field label="Role / Title">
                    <Input value={role} onChange={(e) => setRole(e.target.value)} />
                  </Field>
                  <Field label="Department">
                    <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
                  </Field>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Company name *" error={fieldErrors.companyName}>
                    <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} aria-invalid={!!fieldErrors.companyName} />
                  </Field>
                  <Field label="Department / Division">
                    <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
                  </Field>
                </div>
              )}
            </section>

            {/* Primary comms */}
            <section className="grid gap-4">
              <h3 className="text-sm font-semibold text-muted-foreground">Primary contact details</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email" error={fieldErrors.email}>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fieldErrors.email} />
                </Field>
                <Field label="Phone">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
              </div>
            </section>

            {/* Relationship */}
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold text-muted-foreground">Relationship</h3>
              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={isCustomer} onCheckedChange={setIsCustomer} />
                  Customer
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={isVendor} onCheckedChange={setIsVendor} />
                  Vendor
                </label>
              </div>
            </section>

            {/* Channels */}
            <section className="grid gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Social &amp; contact channels</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => setChannels((p) => [...p, emptyChannel()])}>
                  <Plus className="mr-1 size-3.5" /> Add channel
                </Button>
              </div>
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground">No channels added.</p>
              ) : (
                <div className="grid gap-2">
                  {channels.map((ch, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select
                        value={ch.type}
                        onValueChange={(v) => setChannels((p) => p.map((c, idx) => (idx === i ? { ...c, type: v } : c)))}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CHANNEL_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        className="min-w-40 flex-1"
                        placeholder="Handle or URL"
                        value={ch.value}
                        onChange={(e) => setChannels((p) => p.map((c, idx) => (idx === i ? { ...c, value: e.target.value } : c)))}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-9 shrink-0"
                        onClick={() => setChannels((p) => p.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Remove channel</span>
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Addresses */}
            <section className="grid gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Addresses</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => setAddresses((p) => [...p, emptyAddress()])}>
                  <Plus className="mr-1 size-3.5" /> Add address
                </Button>
              </div>
              {addresses.length === 0 ? (
                <p className="text-xs text-muted-foreground">No addresses added.</p>
              ) : (
                <div className="grid gap-4">
                  {addresses.map((addr, i) => (
                    <div key={i} className="grid gap-3 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Select
                          value={addr.label}
                          onValueChange={(v) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, label: v } : a)))}
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ADDRESS_LABELS.map((t) => (
                              <SelectItem key={t} value={t}>
                                {t}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch
                              checked={!!addr.is_primary}
                              onCheckedChange={(v) =>
                                setAddresses((p) => p.map((a, idx) => ({ ...a, is_primary: idx === i ? v : v ? false : a.is_primary })))
                              }
                            />
                            Primary
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            onClick={() => setAddresses((p) => p.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 className="size-4" />
                            <span className="sr-only">Remove address</span>
                          </Button>
                        </div>
                      </div>
                      <Input
                        placeholder="Address line 1"
                        value={addr.line1}
                        onChange={(e) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, line1: e.target.value } : a)))}
                      />
                      <Input
                        placeholder="Address line 2"
                        value={addr.line2 ?? ""}
                        onChange={(e) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, line2: e.target.value } : a)))}
                      />
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Input
                          placeholder="City"
                          value={addr.city ?? ""}
                          onChange={(e) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, city: e.target.value } : a)))}
                        />
                        <Input
                          placeholder="State"
                          value={addr.state ?? ""}
                          onChange={(e) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, state: e.target.value } : a)))}
                        />
                        <Input
                          placeholder="Postal code"
                          value={addr.postal_code ?? ""}
                          onChange={(e) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, postal_code: e.target.value } : a)))}
                        />
                        <Input
                          placeholder="Country"
                          value={addr.country ?? ""}
                          onChange={(e) => setAddresses((p) => p.map((a, idx) => (idx === i ? { ...a, country: e.target.value } : a)))}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Notes */}
            <section className="grid gap-2">
              <Label htmlFor="contact-notes">Notes</Label>
              <Textarea id="contact-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </section>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : contact ? "Save changes" : "Create contact"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Duplicate confirmation */}
      <AlertDialog open={!!dupes} onOpenChange={(v) => !v && setDupes(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Possible duplicate contact</AlertDialogTitle>
            <AlertDialogDescription>
              A similar contact already exists. Review the matches below before creating a new record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid max-h-60 gap-2 overflow-y-auto">
            {(dupes ?? []).map((d) => (
              <div key={d.id} className="rounded-md border border-border p-2 text-sm">
                <div className="font-medium">{d.full_name}</div>
                <div className="text-xs text-muted-foreground">
                  {[d.contact_code, d.company_name, d.email, d.phone].filter(Boolean).join(" · ")}
                </div>
                <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">Matched on: {d.reason}</div>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit(true)}>Create anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
