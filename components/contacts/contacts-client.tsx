"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { useNewRecordParam } from "@/lib/use-new-record-param"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Building2, MoreHorizontal, Plus, Search, UserRound, Pencil, GitMerge, Archive } from "lucide-react"
import { ContactDialog, type ContactRow } from "@/components/contacts/contact-dialog"
import { MergeDialog } from "@/components/contacts/merge-dialog"

export function ContactsClient({ canManage }: { canManage: boolean }) {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [relFilter, setRelFilter] = useState<string>("all")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ContactRow | null>(null)
  const [mergeFor, setMergeFor] = useState<ContactRow | null>(null)
  const [archiveFor, setArchiveFor] = useState<ContactRow | null>(null)

  const params = new URLSearchParams()
  if (search) params.set("q", search)
  if (typeFilter !== "all") params.set("type", typeFilter)
  if (relFilter !== "all") params.set("relationship", relFilter)
  const key = `/api/contacts${params.toString() ? `?${params.toString()}` : ""}`
  const { data, isLoading, mutate } = useSWR<{ contacts: ContactRow[] }>(key, fetcher)

  const contacts = data?.contacts ?? []

  useNewRecordParam(() => {
    if (canManage) {
      setEditing(null)
      setDialogOpen(true)
    }
  })

  const counts = useMemo(() => {
    let people = 0
    let companies = 0
    let customers = 0
    let vendors = 0
    for (const c of contacts) {
      if (c.contact_type === "Company") companies++
      else people++
      if (c.is_customer) customers++
      if (c.is_vendor) vendors++
    }
    return { people, companies, customers, vendors, total: contacts.length }
  }, [contacts])

  function openNew() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(c: ContactRow) {
    setEditing(c)
    setDialogOpen(true)
  }

  async function confirmArchive() {
    if (!archiveFor) return
    const res = await fetch(`/api/contacts/${archiveFor.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Contact archived")
      mutate()
    } else {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error || "Unable to archive")
    }
    setArchiveFor(null)
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
            <p className="text-sm text-muted-foreground">
              One centralized record for every person and company — linked across CRM, Sales, Finance and Marketing.
            </p>
          </div>
          {canManage && (
            <Button onClick={openNew}>
              <Plus className="mr-1 size-4" /> Add contact
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total" value={counts.total} />
          <StatCard label="People" value={counts.people} icon={<UserRound className="size-4" />} />
          <StatCard label="Companies" value={counts.companies} icon={<Building2 className="size-4" />} />
          <StatCard label="Customers / Vendors" value={`${counts.customers} / ${counts.vendors}`} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, company, email, phone…"
              className="pl-8"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="Person">People</SelectItem>
              <SelectItem value="Company">Companies</SelectItem>
            </SelectContent>
          </Select>
          <Select value={relFilter} onValueChange={setRelFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Relationship" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All relationships</SelectItem>
              <SelectItem value="customer">Customers</SelectItem>
              <SelectItem value="vendor">Vendors</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role / Dept</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Relationship</TableHead>
              <TableHead>Linked</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Loading contacts…
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No contacts yet.{canManage ? " Add your first contact to get started." : ""}
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => canManage && openEdit(c)}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                        aria-hidden
                      >
                        {c.contact_type === "Company" ? <Building2 className="size-4" /> : <UserRound className="size-4" />}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{c.full_name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.contact_type === "Person" && c.company_name ? c.company_name : c.contact_code}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {[c.role, c.department].filter(Boolean).join(" · ") || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{c.email || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-sm">{c.phone || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {c.is_customer ? <Badge variant="secondary">Customer</Badge> : null}
                      {c.is_vendor ? <Badge variant="secondary">Vendor</Badge> : null}
                      {!c.is_customer && !c.is_vendor ? <span className="text-xs text-muted-foreground">—</span> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                      {c.client_id ? <Badge variant="outline">CRM</Badge> : null}
                      {c.finance_party_id ? <Badge variant="outline">Finance</Badge> : null}
                      {c.sales_company_id || c.sales_contact_id ? <Badge variant="outline">Sales</Badge> : null}
                      {c.marketing_contact_id ? <Badge variant="outline">Marketing</Badge> : null}
                      {!c.client_id &&
                      !c.finance_party_id &&
                      !c.sales_company_id &&
                      !c.sales_contact_id &&
                      !c.marketing_contact_id ? (
                        <span>—</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(c)}>
                            <Pencil className="mr-2 size-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setMergeFor(c)}>
                            <GitMerge className="mr-2 size-4" /> Merge duplicate…
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onClick={() => setArchiveFor(c)}>
                            <Archive className="mr-2 size-4" /> Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {canManage && (
        <ContactDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          contact={editing}
          onSaved={() => mutate()}
        />
      )}

      {canManage && mergeFor && (
        <MergeDialog
          survivor={mergeFor}
          open={!!mergeFor}
          onOpenChange={(v) => !v && setMergeFor(null)}
          onMerged={() => {
            setMergeFor(null)
            mutate()
          }}
        />
      )}

      <AlertDialog open={!!archiveFor} onOpenChange={(v) => !v && setArchiveFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive contact?</AlertDialogTitle>
            <AlertDialogDescription>
              {archiveFor?.full_name} will be hidden from the contacts list. Links to CRM, Finance, Sales and Marketing
              records are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number | string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold">{value}</div>
      </div>
      {icon ? <span className="text-muted-foreground">{icon}</span> : null}
    </div>
  )
}
