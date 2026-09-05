"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
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
import { MoreHorizontal, Plus, Search, BriefcaseBusiness } from "lucide-react"

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
}

const SALUTATIONS = ["Mr", "Mrs", "Ms", "Dr"] as const

type Field = { key: keyof ClientRow; label: string; type?: string; required?: boolean }

const ACCOUNT_FIELDS: Field[] = [
  { key: "client_name", label: "Client Name", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "mobile", label: "Mobile" },
  { key: "gender", label: "Gender" },
  { key: "language", label: "Language" },
]

const COMPANY_FIELDS: Field[] = [
  { key: "company_name", label: "Company Name" },
  { key: "website", label: "Website" },
  { key: "tax_name", label: "Tax Name" },
  { key: "gst_number", label: "GST/VAT Number" },
  { key: "office_phone", label: "Office Phone" },
  { key: "category", label: "Category" },
  { key: "sub_category", label: "Sub Category" },
  { key: "currency", label: "Currency" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "postal_code", label: "Postal Code" },
]

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

  // Sync form state whenever the dialog opens for a new/edit target.
  const seed = useMemo(() => {
    const base: Record<string, string> = {
      salutation: client?.salutation ?? "Mr",
      login_allowed: client?.login_allowed ?? "No",
      email_notifications: client?.email_notifications ?? "Yes",
      status: client?.status ?? "Active",
    }
    for (const f of [...ACCOUNT_FIELDS, ...COMPANY_FIELDS]) {
      base[f.key as string] = (client?.[f.key] as string) ?? ""
    }
    base.notes = client?.notes ?? ""
    return base
  }, [client])

  const value = (k: string) => (k in form ? form[k] : seed[k]) ?? ""
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload: Record<string, string> = { ...seed, ...form }
    const res = await fetch(client ? `/api/clients/${client.id}` : "/api/clients", {
      method: client ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) {
      onOpenChange(false)
      setForm({})
      onSaved()
    } else {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error || "Unable to save client")
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setForm({})
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{client ? "Edit client" : "Add client"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-6">
          <section className="grid gap-4">
            <h3 className="text-sm font-semibold text-muted-foreground">Client Details</h3>
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
              {ACCOUNT_FIELDS.map((f) => (
                <div key={f.key as string} className="grid gap-2">
                  <Label htmlFor={f.key as string}>
                    {f.label}
                    {f.required ? " *" : ""}
                  </Label>
                  <Input
                    id={f.key as string}
                    type={f.type || "text"}
                    required={f.required}
                    value={value(f.key as string)}
                    onChange={(e) => set(f.key as string, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4">
            <h3 className="text-sm font-semibold text-muted-foreground">Company Details</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              {COMPANY_FIELDS.map((f) => (
                <div key={f.key as string} className="grid gap-2">
                  <Label htmlFor={f.key as string}>{f.label}</Label>
                  <Input
                    id={f.key as string}
                    type={f.type || "text"}
                    value={value(f.key as string)}
                    onChange={(e) => set(f.key as string, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" rows={3} value={value("notes")} onChange={(e) => set("notes", e.target.value)} />
            </div>
          </section>

          <section className="grid gap-4">
            <h3 className="text-sm font-semibold text-muted-foreground">Portal Access</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="login_allowed">Login Allowed</Label>
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
                <Label htmlFor="email_notifications">Email Notifications</Label>
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

          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : client ? "Update client" : "Save client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ClientsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ clients: ClientRow[] }>("/api/clients", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClientRow | null>(null)

  const clients = data?.clients ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return clients
    return clients.filter((c) =>
      [c.client_code, c.client_name, c.email, c.company_name, c.category, c.country]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    )
  }, [clients, search])

  async function deleteClient(client: ClientRow) {
    if (!confirm(`Delete ${client.client_name}? This cannot be undone.`)) return
    const res = await fetch(`/api/clients/${client.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Client deleted")
      mutate()
    } else {
      toast.error("Unable to delete client")
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
              <TableHead>Category</TableHead>
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
                  <div className="flex flex-col">
                    <span className="font-medium">
                      {client.salutation ? `${client.salutation} ` : ""}
                      {client.client_name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {client.client_code} · {client.email}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{client.company_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {client.category ? (
                    <span>
                      {client.category}
                      {client.sub_category ? ` / ${client.sub_category}` : ""}
                    </span>
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
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(client)
                            setDialogOpen(true)
                          }}
                        >
                          Edit client
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => deleteClient(client)}>
                          Delete client
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
    </div>
  )
}
