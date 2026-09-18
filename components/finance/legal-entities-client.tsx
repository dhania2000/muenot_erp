"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { inr } from "@/lib/finance-calc"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldLabel } from "@/components/ui/field"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Building2, Plus, Star, Pencil, Trash2, Landmark, ArrowLeftRight, BarChart3,
  RefreshCw, Loader2Icon, Check, X, MapPin, ReceiptText,
} from "lucide-react"
import type { BadgeVariant } from "@/lib/finance-schema"

type Entity = {
  id: number
  entity_code: string
  name: string
  legal_name: string | null
  entity_type: string
  registration_no: string | null
  tax_name: string | null
  tax_number: string | null
  secondary_tax_name: string | null
  secondary_tax_number: string | null
  base_currency: string
  book_name: string | null
  email: string | null
  phone: string | null
  address_line: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  is_default: number
  status: "active" | "inactive"
  bank_account_count?: number
}

type BankAccount = {
  id: number
  entity_id: number
  account_name: string
  bank_name: string | null
  account_no: string | null
  ifsc_swift: string | null
  branch: string | null
  currency: string
  account_type: string | null
  is_primary: number
}

type Intercompany = {
  id: number
  txn_code: string
  from_entity_id: number
  to_entity_id: number
  from_entity_name?: string
  to_entity_name?: string
  txn_date: string | null
  amount: number
  currency: string
  category: string | null
  description: string | null
  reference_no: string | null
  status: "draft" | "posted" | "settled" | "cancelled"
}

type ReportRow = {
  entity_id: number | null
  entity_code: string | null
  entity_name: string
  base_currency: string
  debit: number
  credit: number
  net: number
  entries: number
}

type ConsolidatedReport = {
  entities: ReportRow[]
  unassigned: ReportRow | null
  totals: { debit: number; credit: number; net: number; entries: number }
  intercompany: { count: number; eliminated: number; byPair: Array<{ from: string; to: string; amount: number }> }
  consolidated: { debit: number; credit: number; net: number }
}

const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: "private_limited", label: "Private Limited" },
  { value: "public_limited", label: "Public Limited" },
  { value: "llp", label: "LLP" },
  { value: "partnership", label: "Partnership" },
  { value: "proprietorship", label: "Proprietorship" },
  { value: "branch", label: "Branch" },
  { value: "subsidiary", label: "Subsidiary" },
  { value: "joint_venture", label: "Joint Venture" },
  { value: "trust", label: "Trust" },
  { value: "other", label: "Other" },
]
const ENTITY_TYPE_LABEL = Object.fromEntries(ENTITY_TYPES.map((t) => [t.value, t.label]))

const STATUS_BADGE: Record<Intercompany["status"], BadgeVariant> = {
  draft: "outline",
  posted: "default",
  settled: "secondary",
  cancelled: "destructive",
}

const emptyEntity = {
  entity_code: "",
  name: "",
  legal_name: "",
  entity_type: "private_limited",
  registration_no: "",
  tax_name: "GSTIN",
  tax_number: "",
  secondary_tax_name: "",
  secondary_tax_number: "",
  base_currency: "INR",
  book_name: "",
  email: "",
  phone: "",
  address_line: "",
  city: "",
  state: "",
  postal_code: "",
  country: "India",
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || "Request failed")
  return data
}

export function LegalEntitiesClient() {
  return (
    <div className="space-y-6 px-6 pb-10 pt-6">
      <header className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Building2 className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Legal Entities</h1>
          <p className="text-sm text-muted-foreground">
            Operate multiple legal entities under one tenant — separate tax identities, bank accounts,
            accounting books and addresses, with entity-level and consolidated reporting.
          </p>
        </div>
      </header>

      <Tabs defaultValue="entities" className="w-full">
        <TabsList>
          <TabsTrigger value="entities">
            <Building2 className="mr-1.5 size-4" /> Entities
          </TabsTrigger>
          <TabsTrigger value="intercompany">
            <ArrowLeftRight className="mr-1.5 size-4" /> Inter-company
          </TabsTrigger>
          <TabsTrigger value="consolidated">
            <BarChart3 className="mr-1.5 size-4" /> Consolidated
          </TabsTrigger>
        </TabsList>

        <TabsContent value="entities" className="mt-4">
          <EntitiesTab />
        </TabsContent>
        <TabsContent value="intercompany" className="mt-4">
          <IntercompanyTab />
        </TabsContent>
        <TabsContent value="consolidated" className="mt-4">
          <ConsolidatedTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function EntitiesTab() {
  const { data, isValidating, mutate } = useSWR<{ entities: Entity[] }>(
    "/api/finance/entities",
    fetcher,
  )
  const entities = data?.entities ?? []
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Entity | null>(null)
  const [banksFor, setBanksFor] = useState<Entity | null>(null)
  const [error, setError] = useState("")

  function openCreate() {
    setEditing(null)
    setError("")
    setDialogOpen(true)
  }
  function openEdit(e: Entity) {
    setEditing(e)
    setError("")
    setDialogOpen(true)
  }

  async function makeDefault(e: Entity) {
    try {
      await send(`/api/finance/entities/${e.id}/default`, "POST")
      mutate()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  async function remove(e: Entity) {
    if (!confirm(`Delete entity "${e.name}"? This cannot be undone.`)) return
    try {
      await send(`/api/finance/entities/${e.id}`, "DELETE")
      mutate()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {entities.length} {entities.length === 1 ? "entity" : "entities"}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mutate()} disabled={isValidating}>
            <RefreshCw className={`size-4 ${isValidating ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 size-4" /> New Entity
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {entities.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Building2 className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No legal entities yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first entity to start segregating tax identities, books and bank accounts.
            </p>
            <Button size="sm" className="mt-2" onClick={openCreate}>
              <Plus className="mr-1 size-4" /> New Entity
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {entities.map((e) => (
            <Card key={e.id} className="overflow-hidden">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{e.name}</span>
                      {e.is_default ? (
                        <Badge variant="default" className="gap-1">
                          <Star className="size-3" /> Default
                        </Badge>
                      ) : null}
                      {e.status === "inactive" && <Badge variant="outline">Inactive</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {e.entity_code} · {ENTITY_TYPE_LABEL[e.entity_type] ?? e.entity_type} · {e.base_currency}
                    </p>
                  </div>
                </div>

                <div className="space-y-1 text-sm">
                  {e.tax_number && (
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      <ReceiptText className="size-3.5" />
                      {e.tax_name || "Tax"}: <span className="text-foreground">{e.tax_number}</span>
                    </p>
                  )}
                  {(e.city || e.state || e.country) && (
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      <MapPin className="size-3.5" />
                      {[e.city, e.state, e.country].filter(Boolean).join(", ")}
                    </p>
                  )}
                  {e.book_name && (
                    <p className="text-xs text-muted-foreground">Book: {e.book_name}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <Button variant="outline" size="sm" onClick={() => setBanksFor(e)}>
                    <Landmark className="mr-1 size-4" />
                    Banks{typeof e.bank_account_count === "number" ? ` (${e.bank_account_count})` : ""}
                  </Button>
                  {!e.is_default && (
                    <Button variant="outline" size="sm" onClick={() => makeDefault(e)}>
                      <Star className="mr-1 size-4" /> Set default
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => openEdit(e)}>
                    <Pencil className="mr-1 size-4" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => remove(e)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialogOpen && (
        <EntityDialog
          entity={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false)
            mutate()
          }}
        />
      )}
      {banksFor && (
        <BankAccountsDialog entity={banksFor} onClose={() => { setBanksFor(null); mutate() }} />
      )}
    </div>
  )
}

function EntityDialog({
  entity,
  onClose,
  onSaved,
}: {
  entity: Entity | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(() =>
    entity
      ? { ...emptyEntity, ...Object.fromEntries(Object.entries(entity).map(([k, v]) => [k, v ?? ""])) }
      : { ...emptyEntity },
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function save() {
    setSaving(true)
    setError("")
    try {
      if (entity) {
        await send(`/api/finance/entities/${entity.id}`, "PATCH", form)
      } else {
        await send("/api/finance/entities", "POST", form)
      }
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{entity ? "Edit Entity" : "New Legal Entity"}</DialogTitle>
          <DialogDescription>
            Each entity keeps its own tax identity, accounting book, address and bank accounts.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Entity code *</FieldLabel>
            <Input value={form.entity_code} onChange={(e) => set("entity_code", e.target.value)} placeholder="ACME-IN" />
          </Field>
          <Field>
            <FieldLabel>Display name *</FieldLabel>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Acme India" />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>Legal name</FieldLabel>
            <Input value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} placeholder="Acme India Private Limited" />
          </Field>
          <Field>
            <FieldLabel>Entity type</FieldLabel>
            <Select value={form.entity_type} onValueChange={(v) => set("entity_type", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Registration no.</FieldLabel>
            <Input value={form.registration_no} onChange={(e) => set("registration_no", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Base currency</FieldLabel>
            <Input value={form.base_currency} onChange={(e) => set("base_currency", e.target.value.toUpperCase())} placeholder="INR" />
          </Field>
          <Field>
            <FieldLabel>Accounting book</FieldLabel>
            <Input value={form.book_name} onChange={(e) => set("book_name", e.target.value)} placeholder="Acme India Books" />
          </Field>

          <Field>
            <FieldLabel>Tax label</FieldLabel>
            <Input value={form.tax_name} onChange={(e) => set("tax_name", e.target.value)} placeholder="GSTIN / VAT" />
          </Field>
          <Field>
            <FieldLabel>Tax number</FieldLabel>
            <Input value={form.tax_number} onChange={(e) => set("tax_number", e.target.value)} placeholder="27AABCU9603R1ZM" />
          </Field>
          <Field>
            <FieldLabel>Secondary tax label</FieldLabel>
            <Input value={form.secondary_tax_name} onChange={(e) => set("secondary_tax_name", e.target.value)} placeholder="PAN / TIN" />
          </Field>
          <Field>
            <FieldLabel>Secondary tax number</FieldLabel>
            <Input value={form.secondary_tax_number} onChange={(e) => set("secondary_tax_number", e.target.value)} />
          </Field>

          <Field>
            <FieldLabel>Email</FieldLabel>
            <Input value={form.email} onChange={(e) => set("email", e.target.value)} type="email" />
          </Field>
          <Field>
            <FieldLabel>Phone</FieldLabel>
            <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Address</FieldLabel>
            <Input value={form.address_line} onChange={(e) => set("address_line", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>City</FieldLabel>
            <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>State</FieldLabel>
            <Input value={form.state} onChange={(e) => set("state", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Postal code</FieldLabel>
            <Input value={form.postal_code} onChange={(e) => set("postal_code", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Country</FieldLabel>
            <Input value={form.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2Icon className="mr-1 size-4 animate-spin" />}
            {entity ? "Save changes" : "Create entity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BankAccountsDialog({ entity, onClose }: { entity: Entity; onClose: () => void }) {
  const key = `/api/finance/entities/${entity.id}/bank-accounts`
  const { data, mutate } = useSWR<{ accounts: BankAccount[] }>(key, fetcher)
  const accounts = data?.accounts ?? []
  const [form, setForm] = useState({
    account_name: "",
    bank_name: "",
    account_no: "",
    ifsc_swift: "",
    branch: "",
    currency: entity.base_currency || "INR",
    account_type: "",
    is_primary: false,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  function set(k: string, v: string | boolean) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function add() {
    setSaving(true)
    setError("")
    try {
      await send(key, "POST", form)
      setForm({
        account_name: "", bank_name: "", account_no: "", ifsc_swift: "",
        branch: "", currency: entity.base_currency || "INR", account_type: "", is_primary: false,
      })
      mutate()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  async function remove(id: number) {
    try {
      await send(`/api/finance/entities/bank-accounts/${id}`, "DELETE")
      mutate()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bank accounts — {entity.name}</DialogTitle>
          <DialogDescription>Bank / cash identities used by this entity&apos;s book.</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          {accounts.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No bank accounts yet.
            </p>
          ) : (
            accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{a.account_name}</span>
                    {a.is_primary ? <Badge variant="secondary">Primary</Badge> : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[a.bank_name, a.account_no, a.ifsc_swift, a.currency].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(a.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">Add bank account</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel>Account name *</FieldLabel>
              <Input value={form.account_name} onChange={(e) => set("account_name", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Bank name</FieldLabel>
              <Input value={form.bank_name} onChange={(e) => set("bank_name", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Account no.</FieldLabel>
              <Input value={form.account_no} onChange={(e) => set("account_no", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>IFSC / SWIFT</FieldLabel>
              <Input value={form.ifsc_swift} onChange={(e) => set("ifsc_swift", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Branch</FieldLabel>
              <Input value={form.branch} onChange={(e) => set("branch", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Currency</FieldLabel>
              <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
            </Field>
            <Field>
              <FieldLabel>Account type</FieldLabel>
              <Input value={form.account_type} onChange={(e) => set("account_type", e.target.value)} placeholder="Current / Savings" />
            </Field>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Switch checked={form.is_primary} onCheckedChange={(v) => set("is_primary", v)} id="is_primary" />
              <label htmlFor="is_primary" className="text-sm">Mark as primary account</label>
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={add} disabled={saving}>
              {saving && <Loader2Icon className="mr-1 size-4 animate-spin" />}
              <Plus className="mr-1 size-4" /> Add account
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function IntercompanyTab() {
  const { data: entData } = useSWR<{ entities: Entity[] }>("/api/finance/entities", fetcher)
  const entities = entData?.entities ?? []
  const { data, isValidating, mutate } = useSWR<{ transactions: Intercompany[] }>(
    "/api/finance/entities/intercompany",
    fetcher,
  )
  const txns = data?.transactions ?? []
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const [form, setForm] = useState({
    from_entity_id: "",
    to_entity_id: "",
    txn_date: "",
    amount: "",
    currency: "INR",
    category: "",
    description: "",
    reference_no: "",
  })
  const [saving, setSaving] = useState(false)

  function set(k: string, v: string) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function create() {
    setSaving(true)
    setError("")
    try {
      await send("/api/finance/entities/intercompany", "POST", {
        ...form,
        from_entity_id: Number(form.from_entity_id),
        to_entity_id: Number(form.to_entity_id),
        amount: Number(form.amount),
      })
      setOpen(false)
      setForm({ from_entity_id: "", to_entity_id: "", txn_date: "", amount: "", currency: "INR", category: "", description: "", reference_no: "" })
      mutate()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function setStatus(id: number, status: Intercompany["status"]) {
    try {
      await send(`/api/finance/entities/intercompany/${id}`, "PATCH", { status })
      mutate()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  async function remove(id: number) {
    if (!confirm("Delete this inter-company transaction?")) return
    try {
      await send(`/api/finance/entities/intercompany/${id}`, "DELETE")
      mutate()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const canAdd = entities.length >= 2

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Transfers between your own entities. Posted/settled amounts are eliminated on consolidation.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mutate()} disabled={isValidating}>
            <RefreshCw className={`size-4 ${isValidating ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => { setError(""); setOpen(true) }} disabled={!canAdd}>
            <Plus className="mr-1 size-4" /> New Transaction
          </Button>
        </div>
      </div>

      {!canAdd && (
        <Alert>
          <AlertDescription>Create at least two entities to record inter-company transactions.</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {txns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ArrowLeftRight className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No inter-company transactions</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {txns.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t.txn_code}</span>
                    <Badge variant={STATUS_BADGE[t.status]}>{t.status}</Badge>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm">
                    <span>{t.from_entity_name ?? `#${t.from_entity_id}`}</span>
                    <ArrowLeftRight className="size-3.5 text-muted-foreground" />
                    <span>{t.to_entity_name ?? `#${t.to_entity_id}`}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[t.txn_date, t.category, t.reference_no].filter(Boolean).join(" · ")}
                    {t.description ? ` — ${t.description}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums">
                    {t.currency} {inr(t.amount)}
                  </span>
                  <div className="flex items-center gap-1">
                    {t.status === "draft" && (
                      <Button variant="outline" size="sm" onClick={() => setStatus(t.id, "posted")}>
                        <Check className="mr-1 size-3.5" /> Post
                      </Button>
                    )}
                    {t.status === "posted" && (
                      <Button variant="outline" size="sm" onClick={() => setStatus(t.id, "settled")}>
                        Settle
                      </Button>
                    )}
                    {(t.status === "draft" || t.status === "posted") && (
                      <Button variant="ghost" size="sm" onClick={() => setStatus(t.id, "cancelled")}>
                        <X className="size-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(t.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New inter-company transaction</DialogTitle>
            <DialogDescription>Record a transfer between two of your entities.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>From entity *</FieldLabel>
              <Select value={form.from_entity_id} onValueChange={(v) => set("from_entity_id", v)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {entities.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>To entity *</FieldLabel>
              <Select value={form.to_entity_id} onValueChange={(v) => set("to_entity_id", v)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {entities.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Amount *</FieldLabel>
              <Input type="number" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Currency</FieldLabel>
              <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
            </Field>
            <Field>
              <FieldLabel>Date</FieldLabel>
              <Input type="date" value={form.txn_date} onChange={(e) => set("txn_date", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Category</FieldLabel>
              <Input value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="Loan / Reimbursement" />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel>Reference no.</FieldLabel>
              <Input value={form.reference_no} onChange={(e) => set("reference_no", e.target.value)} />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel>Description</FieldLabel>
              <Input value={form.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={create} disabled={saving}>
              {saving && <Loader2Icon className="mr-1 size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ConsolidatedTab() {
  const [fy, setFy] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (fy) p.set("financial_year", fy)
    if (from) p.set("date_from", from)
    if (to) p.set("date_to", to)
    const s = p.toString()
    return s ? `?${s}` : ""
  }, [fy, from, to])

  const { data, isValidating, mutate } = useSWR<{ report: ConsolidatedReport }>(
    `/api/finance/entities/consolidated${qs}`,
    fetcher,
  )
  const report = data?.report

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <Field className="w-40">
            <FieldLabel>Financial year</FieldLabel>
            <Input value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2025-26" />
          </Field>
          <Field className="w-40">
            <FieldLabel>From</FieldLabel>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field className="w-40">
            <FieldLabel>To</FieldLabel>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button variant="outline" size="sm" onClick={() => mutate()} disabled={isValidating}>
            <RefreshCw className={`mr-1 size-4 ${isValidating ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Consolidated debit" value={inr(report.consolidated.debit)} />
            <SummaryCard label="Consolidated credit" value={inr(report.consolidated.credit)} />
            <SummaryCard
              label="Inter-company eliminated"
              value={inr(report.intercompany.eliminated)}
              hint={`${report.intercompany.count} txns`}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="p-3 font-medium">Entity</th>
                      <th className="p-3 text-right font-medium">Debit</th>
                      <th className="p-3 text-right font-medium">Credit</th>
                      <th className="p-3 text-right font-medium">Net</th>
                      <th className="p-3 text-right font-medium">Entries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.entities.map((r) => (
                      <tr key={r.entity_id ?? "x"} className="border-b last:border-0">
                        <td className="p-3">
                          <div className="font-medium">{r.entity_name}</div>
                          {r.entity_code && <div className="text-xs text-muted-foreground">{r.entity_code}</div>}
                        </td>
                        <td className="p-3 text-right tabular-nums">{inr(r.debit)}</td>
                        <td className="p-3 text-right tabular-nums">{inr(r.credit)}</td>
                        <td className="p-3 text-right tabular-nums">{inr(r.net)}</td>
                        <td className="p-3 text-right tabular-nums text-muted-foreground">{r.entries}</td>
                      </tr>
                    ))}
                    {report.unassigned && (
                      <tr className="border-b bg-muted/30 last:border-0">
                        <td className="p-3">
                          <div className="font-medium text-muted-foreground">{report.unassigned.entity_name}</div>
                        </td>
                        <td className="p-3 text-right tabular-nums">{inr(report.unassigned.debit)}</td>
                        <td className="p-3 text-right tabular-nums">{inr(report.unassigned.credit)}</td>
                        <td className="p-3 text-right tabular-nums">{inr(report.unassigned.net)}</td>
                        <td className="p-3 text-right tabular-nums text-muted-foreground">{report.unassigned.entries}</td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="p-3">Total (all books)</td>
                      <td className="p-3 text-right tabular-nums">{inr(report.totals.debit)}</td>
                      <td className="p-3 text-right tabular-nums">{inr(report.totals.credit)}</td>
                      <td className="p-3 text-right tabular-nums">{inr(report.totals.net)}</td>
                      <td className="p-3 text-right tabular-nums">{report.totals.entries}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>

          {report.intercompany.byPair.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <p className="mb-2 text-sm font-medium">Inter-company eliminations</p>
                <div className="space-y-1">
                  {report.intercompany.byPair.map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5">
                        {p.from} <ArrowLeftRight className="size-3.5 text-muted-foreground" /> {p.to}
                      </span>
                      <span className="tabular-nums">{inr(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
