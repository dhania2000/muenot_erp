"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState, SearchInput, SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import { ClientDetailDrawer } from "./client-detail-drawer"
import { NewAccountDialog } from "./new-account-dialog"
import {
  CLIENTS,
  ONBOARDING_LABELS,
  STATUS_LABELS,
  type PortalClient,
  type PortalStatus,
} from "./data"
import { Building2, Download, MoreHorizontal, UserPlus } from "lucide-react"

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "invited", label: "Invited" },
  { value: "suspended", label: "Suspended" },
  { value: "rejected", label: "Rejected" },
  { value: "disabled", label: "Disabled" },
]

export function DirectorySection() {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [onboarding, setOnboarding] = useState("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<PortalClient | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CLIENTS.filter((c) => {
      if (status !== "all" && c.status !== status) return false
      if (onboarding !== "all" && c.onboarding !== onboarding) return false
      if (!q) return true
      return [c.name, c.company, c.clientId, c.contact, c.contactEmail]
        .some((v) => v.toLowerCase().includes(q))
    })
  }, [query, status, onboarding])

  const allChecked = filtered.length > 0 && filtered.every((c) => selected.has(c.id))

  function toggleAll() {
    setSelected((prev) => {
      if (allChecked) return new Set()
      return new Set(filtered.map((c) => c.id))
    })
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function openClient(c: PortalClient) {
    setActive(c)
    setDrawerOpen(true)
  }

  function bulk(label: string) {
    toast.success(`${label} — ${selected.size} client(s)`)
    setSelected(new Set())
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Client Directory"
        description="Every client organisation with a portal account — search, filter and manage access."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => toast.success("Export started")}>
              <Download className="size-4" /> Export
            </Button>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <UserPlus className="size-4" /> Create Portal Account
            </Button>
          </>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search clients, contacts, IDs…" className="w-full sm:w-72" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={onboarding} onValueChange={setOnboarding}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All onboarding</SelectItem>
            <SelectItem value="not_started">Not started</SelectItem>
            <SelectItem value="in_progress">In progress</SelectItem>
            <SelectItem value="documents_pending">Documents pending</SelectItem>
            <SelectItem value="review">In review</SelectItem>
            <SelectItem value="complete">Complete</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">{filtered.length} of {CLIENTS.length}</span>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="xs" variant="outline" onClick={() => bulk("Activated")}>Activate</Button>
          <Button size="xs" variant="outline" onClick={() => bulk("Suspended")}>Suspend</Button>
          <Button size="xs" variant="outline" onClick={() => bulk("Invitation resent")}>Resend invite</Button>
          <Button size="xs" variant="outline" onClick={() => bulk("Access profile assigned")}>Assign profile</Button>
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      ) : null}

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState icon={Building2} title="No clients match" description="Adjust your search or filters to see portal clients." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all" />
                </TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Onboarding</TableHead>
                <TableHead>Access profile</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => openClient(c)}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggleOne(c.id)} aria-label={`Select ${c.name}`} />
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{c.clientId} · {c.contactEmail}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={STATUS_LABELS[c.status as PortalStatus]} tone={portalStatusTone(c.status)} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{ONBOARDING_LABELS[c.onboarding]}</TableCell>
                  <TableCell className="text-sm">{c.accessProfile}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.users}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.lastLogin ?? "Never"}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openClient(c)}>Open 360 view</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Edit opened")}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Invitation resent")}>Resend invite</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => toast.success(`Suspended ${c.name}`)}>Suspend</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success(`Sessions revoked`)}>Revoke sessions</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ClientDetailDrawer client={active} open={drawerOpen} onOpenChange={setDrawerOpen} />
      <NewAccountDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
