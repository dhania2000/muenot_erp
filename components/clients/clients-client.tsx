"use client"

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { useNewRecordParam } from "@/lib/use-new-record-param"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, Search, BriefcaseBusiness, Building2, UserRound, ArrowLeft, ArrowRight, Check, GitMerge, Eye, Pencil } from "lucide-react"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { EntityCombobox, type ComboOption } from "@/components/clients/entity-combobox"
import { Client360Drawer } from "@/components/clients/client-360-drawer"

export type ClientRow = {
  id: number
  client_code: string
  salutation: string | null
  client_name: string
  email: string
  login_allowed: "Yes" | "No"
  email_notifications: "Yes" | "No"
  gender: string | null
  language: string | null
  mobile: string | null
  company_name: string | null
  website: string | null
  tax_name: string | null
  gst_number: string | null
  office_phone: string | null
  address: string | null
  city: string | null
  state: string | null
  country: string | null
  postal_code: string | null
  category: string | null
  sub_category: string | null
  currency: string | null
  status: "Active" | "Inactive"
  notes: string | null
  created_at: string
  // Relational + tax fields added in the foundation phase.
  client_type?: "Company" | "Individual"
  legal_name?: string | null
  display_name?: string | null
  company_id?: number | null
  primary_contact_id?: number | null
  finance_party_id?: string | null
  pan?: string | null
  state_code?: string | null
  account_manager_id?: number | null
  payment_terms_days?: number | null
  credit_limit?: number | null
  row_version?: number
  archived_at?: string | null
  linked_company_name?: string | null
  company_code?: string | null
  finance_party_name?: string | null
  account_manager_name?: string | null
}

type DuplicateMatch = {
  id: number
  client_code: string
  client_name: string
  company_name: string | null
  email: string | null
  gst_number: string | null
  pan: string | null
  reason: string
}

const SALUTATIONS = ["Mr", "Mrs", "Ms", "Dr"] as const

type Field = { key: string; label: string; type?: string; required?: boolean }

const CONTACT_FIELDS: Field[] = [
  { key: "client_name", label: "Contact Name", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "mobile", label: "Mobile" },
  { key: "gender", label: "Gender" },
  { key: "language", label: "Language" },
]

const COMPANY_FIELDS: Field[] = [
  { key: "company_name", label: "Company Name" },
  { key: "legal_name", label: "Legal Name" },
  { key: "website", label: "Website" },
  { key: "tax_name", label: "Tax Name" },
  { key: "gst_number", label: "GSTIN" },
  { key: "pan", label: "PAN" },
  { key: "office_phone", label: "Office Phone" },
  { key: "category", label: "Category" },
  { key: "sub_category", label: "Sub Category" },
  { key: "currency", label: "Currency" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "state_code", label: "State Code" },
  { key: "country", label: "Country" },
  { key: "postal_code", label: "Postal Code" },
]

const BILLING_FIELDS: Field[] = [
  { key: "payment_terms_days", label: "Payment Terms (days)", type: "number" },
  { key: "credit_limit", label: "Credit Limit", type: "number" },
]

const STEPS = ["Account & contact", "Company & tax", "Billing & portal"] as const

function ClientDialog({
  open,
  onOpenChange,
  client,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  client: ClientRow | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null)
  const [step, setStep] = useState(0)

  const seed = useMemo(() => {
    const base: Record<string, string> = {
      salutation: client?.salutation ?? "Mr",
      login_allowed: client?.login_allowed ?? "No",
      email_notifications: client?.email_notifications ?? "Yes",
      status: client?.status ?? "Active",
      client_type: client?.client_type ?? "Company",
      company_id: client?.company_id != null ? String(client.company_id) : "",
      primary_contact_id: client?.primary_contact_id != null ? String(client.primary_contact_id) : "",
      finance_party_id: client?.finance_party_id ?? "",
    }
    for (const f of [...CONTACT_FIELDS, ...COMPANY_FIELDS, ...BILLING_FIELDS]) {
      base[f.key] = (client?.[f.key as keyof ClientRow] as string) ?? ""
    }
    base.notes = client?.notes ?? ""
    return base
  }, [client])

  const value = (k: string) => (k in form ? form[k] : seed[k]) ?? ""
  const set = (k: string, v: string) => {
    setForm((p) => ({ ...p, [k]: v }))
    setFieldErrors((p) => (p[k] ? { ...p, [k]: "" } : p))
  }
  const patch = (obj: Record<string, string>) => setForm((p) => ({ ...p, ...obj }))

  const searchCompanies = useCallback(async (q: string): Promise<ComboOption[]> => {
    const res = await fetch(`/api/clients/lookups?entity=companies&q=${encodeURIComponent(q)}`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.companies ?? []).map((c: any) => ({
      value: String(c.id),
      label: c.company_name,
      sub: [c.company_code, c.city].filter(Boolean).join(" · "),
      data: c,
    }))
  }, [])

  const searchContacts = useCallback(
    async (q: string): Promise<ComboOption[]> => {
      const cid = value("company_id")
      if (!cid) return []
      const res = await fetch(`/api/clients/lookups?entity=contacts&company_id=${cid}`)
      if (!res.ok) return []
      const data = await res.json()
      let list = (data.contacts ?? []) as any[]
      if (q) list = list.filter((c) => String(c.name || "").toLowerCase().includes(q.toLowerCase()))
      return list.map((c) => ({
        value: String(c.id),
        label: c.name,
        sub: [c.title, c.email].filter(Boolean).join(" · "),
        data: c,
      }))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.company_id, seed.company_id],
  )

  function linkCompany(opt: ComboOption) {
    const c = opt.data ?? {}
    patch({
      company_id: String(c.id),
      company_name: c.company_name || "",
      legal_name: c.legal_name || c.company_name || "",
      website: c.website || (c.domain ? `https://${c.domain}` : value("website")),
      office_phone: c.phone || value("office_phone"),
      address: c.address_line || value("address"),
      city: c.city || value("city"),
      state: c.state || value("state"),
      postal_code: c.postal_code || value("postal_code"),
      client_type: "Company",
      primary_contact_id: "",
    })
  }

  function linkContact(opt: ComboOption) {
    const c = opt.data ?? {}
    patch({
      primary_contact_id: String(c.id),
      client_name: c.name || value("client_name"),
      email: c.email || value("email"),
      mobile: c.phone || value("mobile"),
    })
  }

  // Validate the current step before advancing. Step 0 owns the required
  // identity fields; later steps are optional so they never block navigation.
  function advance(): boolean {
    if (step === 0) {
      const errs: Record<string, string> = {}
      if (!value("client_name").trim()) errs.client_name = "Contact name is required"
      const email = value("email").trim()
      if (!email) errs.email = "Email is required"
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email address"
      if (Object.keys(errs).length > 0) {
        setFieldErrors(errs)
        toast.error("Please fix the highlighted fields")
        return false
      }
    }
    return true
  }

  async function submit(force: boolean) {
    setSaving(true)
    const payload: Record<string, any> = { ...seed, ...form }
    if (force) payload.force = true
    if (client?.row_version != null) payload.row_version = client.row_version

    const res = await fetch(client ? `/api/clients/${client.id}` : "/api/clients", {
      method: client ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    const data = await res.json().catch(() => ({}) as any)

    if (res.ok) {
      setDupes(null)
      onOpenChange(false)
      setForm({})
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
    toast.error(data.error || "Unable to save client")
  }

  const companyLinked = !!value("company_id")
  const contactLinked = !!value("primary_contact_id")

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            setForm({})
            setFieldErrors({})
            setStep(0)
          }
          onOpenChange(v)
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{client ? "Edit client" : "Add client"}</DialogTitle>
          </DialogHeader>

          {/* Stepper */}
          <ol className="flex items-center gap-2 text-xs">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={
                    "flex size-5 items-center justify-center rounded-full text-[11px] font-medium " +
                    (i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "border border-primary text-primary"
                        : "border border-border text-muted-foreground")
                  }
                >
                  {i < step ? <Check className="size-3" /> : i + 1}
                </span>
                <span className={i === step ? "font-medium" : "text-muted-foreground"}>{label}</span>
                {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
              </li>
            ))}
          </ol>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              setFieldErrors({})
              if (step < STEPS.length - 1) {
                if (!advance()) return
                setStep((s) => s + 1)
                return
              }
              submit(false)
            }}
            className="grid gap-6"
          >
            {/* Step 1 — link to the canonical account + contact masters. */}
            <section className={(step === 0 ? "" : "hidden ") + "grid gap-4 rounded-lg border border-border bg-muted/30 p-4"}>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Building2 className="size-4 text-primary" /> Link to account
              </h3>
              <p className="-mt-2 text-xs text-muted-foreground">
                Search an existing company to auto-fill its details, or leave blank to create a standalone client.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Company account</Label>
                  <EntityCombobox
                    selectedLabel={companyLinked ? value("company_name") || "Linked account" : null}
                    placeholder="Search companies…"
                    emptyText="No companies found"
                    onSearch={searchCompanies}
                    onSelect={linkCompany}
                    onClear={() => patch({ company_id: "", primary_contact_id: "" })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Primary contact</Label>
                  <EntityCombobox
                    selectedLabel={contactLinked ? value("client_name") || "Selected contact" : null}
                    placeholder={companyLinked ? "Search contacts…" : "Link a company first"}
                    emptyText="No contacts on this account"
                    disabled={!companyLinked}
                    onSearch={searchContacts}
                    onSelect={linkContact}
                    onClear={() => patch({ primary_contact_id: "" })}
                  />
                </div>
              </div>
            </section>

            <section className={(step === 0 ? "" : "hidden ") + "grid gap-4"}>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <UserRound className="size-4" /> Contact details
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="salutation">Salutation</Label>
                  <Select value={value("salutation")} onValueChange={(v) => set("salutation", v as string)}>
                    <SelectTrigger id="salutation">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALUTATIONS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {CONTACT_FIELDS.map((f) => (
                  <div key={f.key} className="grid gap-2">
                    <Label htmlFor={f.key}>
                      {f.label}
                      {f.required ? " *" : ""}
                    </Label>
                    <Input
                      id={f.key}
                      type={f.type || "text"}
                      required={f.required}
                      aria-invalid={!!fieldErrors[f.key]}
                      value={value(f.key)}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                    {fieldErrors[f.key] && <p className="text-xs text-destructive">{fieldErrors[f.key]}</p>}
                  </div>
                ))}
              </div>
            </section>

            <section className={(step === 1 ? "" : "hidden ") + "grid gap-4"}>
              <h3 className="text-sm font-semibold text-muted-foreground">Company &amp; tax details</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {COMPANY_FIELDS.map((f) => (
                  <div key={f.key} className="grid gap-2">
                    <Label htmlFor={f.key}>{f.label}</Label>
                    <Input
                      id={f.key}
                      type={f.type || "text"}
                      aria-invalid={!!fieldErrors[f.key]}
                      value={value(f.key)}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                    {fieldErrors[f.key] && <p className="text-xs text-destructive">{fieldErrors[f.key]}</p>}
                  </div>
                ))}
              </div>
              {client?.finance_party_id ? (
                <p className="text-xs text-muted-foreground">
                  Finance profile linked: <span className="font-medium text-foreground">{client.finance_party_name || client.finance_party_id}</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A matching finance profile is linked automatically by GSTIN or PAN when one exists.
                </p>
              )}
              <div className="grid gap-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" rows={3} value={value("notes")} onChange={(e) => set("notes", e.target.value)} />
              </div>
            </section>

            <section className={(step === 2 ? "" : "hidden ") + "grid gap-4"}>
              <h3 className="text-sm font-semibold text-muted-foreground">Billing profile</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {BILLING_FIELDS.map((f) => (
                  <div key={f.key} className="grid gap-2">
                    <Label htmlFor={f.key}>{f.label}</Label>
                    <Input
                      id={f.key}
                      type={f.type || "text"}
                      value={value(f.key)}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <p className="-mt-1 text-xs text-muted-foreground">
                Payment terms and credit limit flow into the linked finance party and are used to auto-fill invoices.
              </p>
            </section>

            <section className={(step === 2 ? "" : "hidden ") + "grid gap-4"}>
              <h3 className="text-sm font-semibold text-muted-foreground">Portal access</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="login_allowed">Login allowed</Label>
                  <Select value={value("login_allowed")} onValueChange={(v) => set("login_allowed", v as string)}>
                    <SelectTrigger id="login_allowed">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Yes">Yes</SelectItem>
                      <SelectItem value="No">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="email_notifications">Email notifications</Label>
                  <Select
                    value={value("email_notifications")}
                    onValueChange={(v) => set("email_notifications", v as string)}
                  >
                    <SelectTrigger id="email_notifications">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Yes">Yes</SelectItem>
                      <SelectItem value="No">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="status">Status</Label>
                  <Select value={value("status")} onValueChange={(v) => set("status", v as string)}>
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <DialogFooter className="sm:justify-between">
              <div>
                {step > 0 && (
                  <Button type="button" variant="outline" onClick={() => setStep((s) => s - 1)}>
                    <ArrowLeft className="size-4" /> Back
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                {step < STEPS.length - 1 ? (
                  <Button type="submit">
                    Next <ArrowRight className="size-4" />
                  </Button>
                ) : (
                  <Button type="submit" disabled={saving}>
                    {saving ? "Saving…" : client ? "Update client" : "Save client"}
                  </Button>
                )}
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!dupes} onOpenChange={(v) => !v && setDupes(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Possible duplicate client</AlertDialogTitle>
            <AlertDialogDescription>
              We found {dupes?.length} existing client{(dupes?.length ?? 0) > 1 ? "s" : ""} that may be the same party.
              Review before creating a new record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            {dupes?.map((d) => (
              <div key={d.id} className="border-b border-border px-3 py-2 text-sm last:border-b-0">
                <div className="font-medium">
                  {d.company_name || d.client_name}{" "}
                  <span className="font-mono text-xs text-muted-foreground">{d.client_code}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {[d.email, d.gst_number, d.pan].filter(Boolean).join(" · ")}
                </div>
                <Badge variant="outline" className="mt-1">
                  {d.reason}
                </Badge>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDupes(null)
                submit(true)
              }}
            >
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function MergeDialog({
  source,
  clients,
  onOpenChange,
  onMerged,
}: {
  source: ClientRow | null
  clients: ClientRow[]
  onOpenChange: (v: boolean) => void
  onMerged: () => void
}) {
  const [targetId, setTargetId] = useState("")
  const [busy, setBusy] = useState(false)

  const candidates = useMemo(
    () => clients.filter((c) => c.id !== source?.id && !c.archived_at),
    [clients, source],
  )

  async function confirm() {
    if (!source || !targetId) return
    setBusy(true)
    const res = await fetch("/api/clients/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: source.id, target_id: Number(targetId) }),
    })
    setBusy(false)
    const body = await res.json().catch(() => ({}) as any)
    if (res.ok) {
      toast.success(`Merged into ${body.target_name}. ${body.invoices_repointed} invoice(s) repointed.`)
      setTargetId("")
      onOpenChange(false)
      onMerged()
    } else {
      toast.error(body.error || "Unable to merge clients")
    }
  }

  return (
    <Dialog open={!!source} onOpenChange={(v) => !v && onOpenChange(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge client</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Merge <span className="font-medium text-foreground">{source?.company_name || source?.client_name}</span>{" "}
            <span className="font-mono text-xs">{source?.client_code}</span> into another client. Invoices are
            repointed to the survivor and this record is archived. This cannot be undone automatically.
          </p>
          <div className="grid gap-2">
            <Label>Survivor (keep this client)</Label>
            <Select value={targetId} onValueChange={(v) => setTargetId((v as string) ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select the client to keep" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {(c.company_name || c.client_name) + " · " + c.client_code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!targetId || busy} onClick={confirm}>
            {busy ? "Merging…" : "Merge & archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ClientsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ clients: ClientRow[] }>("/api/clients", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClientRow | null>(null)
  const [viewing, setViewing] = useState<ClientRow | null>(null)

  // SPEC 82 — open the create dialog when the command palette deep-links here.
  useNewRecordParam(() => {
    setEditing(null)
    setDialogOpen(true)
  }, canManage)
  const [merging, setMerging] = useState<ClientRow | null>(null)

  const clients = data?.clients ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return clients
    return clients.filter((c) =>
      [c.client_code, c.client_name, c.email, c.company_name, c.gst_number, c.pan, c.category, c.country]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    )
  }, [clients, search])

  async function archiveClient(client: ClientRow) {
    if (!confirm(`Archive ${client.client_name}? Linked invoices stay intact and the client can be restored later.`)) return
    const res = await fetch(`/api/clients/${client.id}`, { method: "DELETE" })
    const body = await res.json().catch(() => ({}) as any)
    if (res.ok) {
      toast.success(body.deleted ? "Client deleted" : "Client archived")
      mutate()
    } else {
      toast.error(body.error || "Unable to archive client")
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <BriefcaseBusiness className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage client accounts, company details and portal access.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExcelExportButton
            rows={filtered}
            filename="clients"
            columns={[
              { header: "Client Code", value: (r: ClientRow) => r.client_code },
              { header: "Client Name", value: (r: ClientRow) => `${r.salutation ? r.salutation + " " : ""}${r.client_name}` },
              { header: "Legal Name", value: (r: ClientRow) => r.legal_name },
              { header: "Client Type", value: (r: ClientRow) => r.client_type },
              { header: "Email", value: (r: ClientRow) => r.email },
              { header: "Mobile", value: (r: ClientRow) => r.mobile },
              { header: "Company", value: (r: ClientRow) => r.company_name },
              { header: "Company Code", value: (r: ClientRow) => r.company_code },
              { header: "Website", value: (r: ClientRow) => r.website },
              { header: "GSTIN", value: (r: ClientRow) => r.gst_number },
              { header: "PAN", value: (r: ClientRow) => r.pan },
              { header: "State Code", value: (r: ClientRow) => r.state_code },
              { header: "Finance Party", value: (r: ClientRow) => r.finance_party_id },
              { header: "Payment Terms (days)", value: (r: ClientRow) => r.payment_terms_days },
              { header: "Credit Limit", value: (r: ClientRow) => r.credit_limit },
              { header: "Account Manager", value: (r: ClientRow) => r.account_manager_name },
              { header: "Category", value: (r: ClientRow) => r.category },
              { header: "Sub Category", value: (r: ClientRow) => r.sub_category },
              { header: "City", value: (r: ClientRow) => r.city },
              { header: "State", value: (r: ClientRow) => r.state },
              { header: "Country", value: (r: ClientRow) => r.country },
              { header: "Currency", value: (r: ClientRow) => r.currency },
              { header: "Login Allowed", value: (r: ClientRow) => r.login_allowed },
              { header: "Status", value: (r: ClientRow) => r.status },
              { header: "Added", value: (r: ClientRow) => r.created_at },
            ]}
          />
          {canManage && <ImportButton moduleKey="clients" onImported={() => mutate()} />}
          {canManage && (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="size-4" /> Add client
            </Button>
          )}
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search clients..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Tax</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Login</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={canManage ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground">
                  Loading clients...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground">
                  No clients found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((client) => (
              <TableRow key={client.id}>
                <TableCell>
                  <button
                    type="button"
                    className="flex flex-col text-left"
                    onClick={() => setViewing(client)}
                  >
                    <span className="font-medium hover:underline">
                      {client.salutation ? `${client.salutation} ` : ""}
                      {client.client_name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {client.client_code} · {client.email}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="flex flex-col">
                    <span>{client.company_name || "—"}</span>
                    {client.company_id ? (
                      <span className="text-xs text-primary">Linked account</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {client.gst_number ? (
                    <span className="font-mono text-xs">{client.gst_number}</span>
                  ) : client.pan ? (
                    <span className="font-mono text-xs">{client.pan}</span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {[client.city, client.country].filter(Boolean).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={client.login_allowed === "Yes" ? "default" : "outline"}>
                    {client.login_allowed === "Yes" ? "Allowed" : "Disabled"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={client.status === "Active" ? "default" : "destructive"}>{client.status}</Badge>
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setViewing(client)}>
                          <Eye className="size-4" /> View 360
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(client)
                            setDialogOpen(true)
                          }}
                        >
                          <Pencil className="size-4" /> Edit client
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMerging(client)}>
                          <GitMerge className="size-4" /> Merge client
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => archiveClient(client)}>
                          Archive client
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ClientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        client={editing}
        onSaved={() => {
          toast.success(editing ? "Client updated" : "Client added")
          mutate()
        }}
      />

      <Client360Drawer
        client={viewing}
        open={!!viewing}
        onOpenChange={(v) => !v && setViewing(null)}
        canManage={canManage}
        onEdit={(c) => {
          setViewing(null)
          setEditing(c)
          setDialogOpen(true)
        }}
        onMerge={(c) => {
          setViewing(null)
          setMerging(c)
        }}
      />

      <MergeDialog
        source={merging}
        clients={clients}
        onOpenChange={(v) => !v && setMerging(null)}
        onMerged={() => mutate()}
      />
    </div>
  )
}
