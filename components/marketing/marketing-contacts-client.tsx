"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import {
  Plus,
  Search,
  Users,
  UserCheck,
  MailWarning,
  TrendingUp,
  MoreHorizontal,
  Upload,
  Download,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { ContactDialog, type OwnerOption } from "@/components/marketing/marketing-contact-dialog"
import { ContactDrawer } from "@/components/marketing/marketing-contact-drawer"
import { ImportDialog } from "@/components/marketing/marketing-contact-import-dialog"

const STAGES = ["Subscriber", "Lead", "MQL", "SQL", "Opportunity", "Customer", "Evangelist", "Other"]
const SUBSCRIPTIONS = ["Subscribed", "Unsubscribed", "Pending"]
const PAGE_SIZE = 25

const SUB_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Subscribed: "default",
  Unsubscribed: "outline",
  Pending: "secondary",
}

export function MarketingContactsClient({
  owners = [],
  canManage = false,
}: {
  owners?: OwnerOption[]
  canManage?: boolean
}) {
  const [q, setQ] = useState("")
  const [stage, setStage] = useState("all")
  const [subscription, setSubscription] = useState("all")
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [drawerId, setDrawerId] = useState<number | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  const [deleting, setDeleting] = useState(false)

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (stage !== "all") params.set("stage", stage)
  if (subscription !== "all") params.set("subscription", subscription)
  params.set("limit", String(PAGE_SIZE))
  params.set("offset", String(page * PAGE_SIZE))

  const listKey = `/api/marketing/contacts?${params.toString()}`
  const { data, isLoading, mutate } = useSWR(listKey, fetcher)
  const { data: statsData, mutate: mutateStats } = useSWR("/api/marketing/contacts/stats", fetcher)

  const contacts: any[] = data?.contacts || []
  const total: number = data?.total || 0
  const stats = statsData?.stats || {}
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const allOnPageSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id))

  function refresh() {
    mutate()
    mutateStats()
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id))
      } else {
        contacts.forEach((c) => next.add(c.id))
      }
      return next
    })
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function bulk(action: string, value?: any) {
    const ids = [...selected]
    if (ids.length === 0) return
    const res = await fetch("/api/marketing/contacts/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action, value }),
    })
    const result = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(result.error || "Bulk action failed")
      return
    }
    toast.success(`Updated ${result.affected} contacts`)
    setSelected(new Set())
    refresh()
  }

  async function sync() {
    setSyncing(true)
    const res = await fetch("/api/marketing/contacts/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "all" }),
    })
    const result = await res.json().catch(() => ({}))
    setSyncing(false)
    if (!res.ok) {
      toast.error(result.error || "Sync failed")
      return
    }
    const c = result.result?.clients
    const l = result.result?.leads
    toast.success(
      `Synced — clients +${c?.created ?? 0}/${c?.updated ?? 0}, leads +${l?.created ?? 0}/${l?.updated ?? 0}`,
    )
    refresh()
  }

  function openNew() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(contact: any) {
    setEditing(contact)
    setDrawerOpen(false)
    setDialogOpen(true)
  }

  function openDrawer(id: number) {
    setDrawerId(id)
    setDrawerOpen(true)
  }

  const deliverability = useMemo(() => {
    const rate = stats.deliverable_rate
    return rate === undefined || rate === null ? "—" : `${rate}%`
  }, [stats])

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Contacts"
        description="Your marketing audience of subscribers, leads, and known accounts — synced from Clients and Leads, organised by lifecycle and segment."
        action={
          canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={sync} disabled={syncing}>
                <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                Sync
              </Button>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="size-4" />
                Import
              </Button>
              <Button variant="outline" asChild>
                <a href="/api/marketing/contacts/export">
                  <Download className="size-4" />
                  Export
                </a>
              </Button>
              <Button onClick={openNew}>
                <Plus className="size-4" />
                Add Contact
              </Button>
            </div>
          ) : (
            <Button variant="outline" asChild>
              <a href="/api/marketing/contacts/export">
                <Download className="size-4" />
                Export
              </a>
            </Button>
          )
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Contacts" value={(stats.total ?? 0).toLocaleString()} icon={Users} />
        <StatCard label="Subscribed" value={(stats.subscribed ?? 0).toLocaleString()} icon={UserCheck} />
        <StatCard
          label="Unsubscribed"
          value={(stats.unsubscribed ?? 0).toLocaleString()}
          icon={MailWarning}
        />
        <StatCard label="Deliverability" value={deliverability} icon={TrendingUp} />
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search name, email, company…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setPage(0)
                }}
                className="pl-8"
              />
            </div>
            <Select
              value={stage}
              onValueChange={(v) => {
                setStage(v)
                setPage(0)
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={subscription}
              onValueChange={(v) => {
                setSubscription(v)
                setPage(0)
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Subscription" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All subscriptions</SelectItem>
                {SUBSCRIPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {canManage && selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm">
              <span className="px-1 font-medium">{selected.size} selected</span>
              <Button size="sm" variant="outline" onClick={() => bulk("subscribe")}>
                Subscribe
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulk("unsubscribe")}>
                Unsubscribe
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    Set stage
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {STAGES.map((s) => (
                    <DropdownMenuItem key={s} onClick={() => bulk("set_stage", s)}>
                      {s}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="outline" onClick={() => bulk("archive")}>
                Archive
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {canManage && (
                    <TableHead className="w-10">
                      <Checkbox checked={allOnPageSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                    </TableHead>
                  )}
                  <TableHead>Contact</TableHead>
                  <TableHead className="hidden md:table-cell">Company</TableHead>
                  <TableHead className="hidden lg:table-cell">Stage</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead className="hidden lg:table-cell">Owner</TableHead>
                  {canManage && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                      Loading contacts…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && contacts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                      No contacts found. {canManage ? "Add one, import a CSV, or sync from Clients and Leads." : ""}
                    </TableCell>
                  </TableRow>
                )}
                {contacts.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => openDrawer(c.id)}>
                    {canManage && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(c.id)}
                          onCheckedChange={() => toggleOne(c.id)}
                          aria-label={`Select ${c.full_name}`}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="font-medium">{c.full_name}</div>
                      <div className="text-xs text-muted-foreground">{c.email || c.phone || c.contact_code}</div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {c.company_name || "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="secondary">{c.lifecycle_stage}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={SUB_VARIANT[c.email_subscription] || "outline"}>{c.email_subscription}</Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {c.owner_name || "Unassigned"}
                    </TableCell>
                    {canManage && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>{c.contact_code}</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => openDrawer(c.id)}>View</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEdit(c)}>Edit</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={async () => {
                                await fetch(`/api/marketing/contacts/${c.id}`, { method: "DELETE" })
                                toast.success("Contact archived")
                                refresh()
                              }}
                            >
                              Archive
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setDeleteTarget(c)} className="text-destructive">
                              <Trash2 className="size-4" />
                              Delete
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

          {total > 0 && (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span>
                  Page {page + 1} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ContactDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        owners={owners}
        editing={editing}
        onSaved={refresh}
      />
      <ContactDrawer contactId={drawerId} open={drawerOpen} onOpenChange={setDrawerOpen} onEdit={openEdit} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={refresh} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">{deleteTarget?.full_name}</span> and all associated tags,
              segment memberships, and activity history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault()
                if (!deleteTarget) return
                setDeleting(true)
                const res = await fetch(`/api/marketing/contacts/${deleteTarget.id}?permanent=true`, {
                  method: "DELETE",
                })
                setDeleting(false)
                if (!res.ok) {
                  const result = await res.json().catch(() => ({}))
                  toast.error(result.error || "Failed to delete contact")
                  return
                }
                toast.success("Contact deleted")
                setSelected((prev) => {
                  const next = new Set(prev)
                  next.delete(deleteTarget.id)
                  return next
                })
                setDeleteTarget(null)
                refresh()
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
