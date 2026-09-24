"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Users, UserPlus, Download, MoreHorizontal, Eye, Send, PauseCircle, Trash2, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SectionHeader, SearchInput, FilterChips, StatusBadge, EmptyState, DataCard } from "./shared"
import { Vendor360Drawer } from "./vendor-360-drawer"
import {
  VENDORS,
  type Vendor,
  PORTAL_STATUS_LABEL,
  ONBOARDING_STATUS_LABEL,
  COMPLIANCE_STATUS_LABEL,
} from "./mock-data"

type FilterKey =
  | "all"
  | "active"
  | "pending"
  | "invited"
  | "suspended"
  | "rejected"
  | "disabled"
  | "compliance_pending"
  | "onboarding_incomplete"

export function DirectorySection() {
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<FilterKey>("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<Vendor | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return VENDORS.filter((v) => {
      if (q) {
        const hay = `${v.name} ${v.code} ${v.company} ${v.contact} ${v.email}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      switch (filter) {
        case "all":
          return true
        case "compliance_pending":
          return v.compliance === "pending" || v.compliance === "expiring"
        case "onboarding_incomplete":
          return v.onboarding !== "completed"
        default:
          return v.portalStatus === filter
      }
    })
  }, [search, filter])

  const counts = useMemo(() => {
    const c = (fn: (v: Vendor) => boolean) => VENDORS.filter(fn).length
    return {
      all: VENDORS.length,
      active: c((v) => v.portalStatus === "active"),
      pending: c((v) => v.portalStatus === "pending"),
      invited: c((v) => v.portalStatus === "invited"),
      suspended: c((v) => v.portalStatus === "suspended"),
      rejected: c((v) => v.portalStatus === "rejected"),
      disabled: c((v) => v.portalStatus === "disabled"),
      compliance_pending: c((v) => v.compliance === "pending" || v.compliance === "expiring"),
      onboarding_incomplete: c((v) => v.onboarding !== "completed"),
    }
  }, [])

  const filterOptions: { value: FilterKey; label: string; count?: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "active", label: "Active", count: counts.active },
    { value: "pending", label: "Pending", count: counts.pending },
    { value: "invited", label: "Invited", count: counts.invited },
    { value: "suspended", label: "Suspended", count: counts.suspended },
    { value: "rejected", label: "Rejected", count: counts.rejected },
    { value: "disabled", label: "Disabled", count: counts.disabled },
    { value: "compliance_pending", label: "Compliance Pending", count: counts.compliance_pending },
    { value: "onboarding_incomplete", label: "Onboarding Incomplete", count: counts.onboarding_incomplete },
  ]

  const allChecked = filtered.length > 0 && filtered.every((v) => selected.has(v.id))
  const someChecked = filtered.some((v) => selected.has(v.id))

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allChecked) filtered.forEach((v) => next.delete(v.id))
      else filtered.forEach((v) => next.add(v.id))
      return next
    })
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Vendor Portal Directory"
        description="Searchable directory of every vendor with portal access. Select a vendor to open the full 360 management view."
        icon={Users}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => toast.success("Export started")}>
              <Download className="size-4" />
              Export
            </Button>
            <Button size="sm" onClick={() => toast.success("Create vendor account")}>
              <UserPlus className="size-4" />
              Create Vendor
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search vendors, codes, contacts…" />
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
      </div>

      {someChecked ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <span className="text-muted-foreground">·</span>
          <Button size="xs" variant="outline" onClick={() => toast.success("Invitations resent")}>
            <Send className="size-3.5" /> Resend Invite
          </Button>
          <Button size="xs" variant="outline" onClick={() => toast.success("Vendors suspended")}>
            <PauseCircle className="size-3.5" /> Suspend
          </Button>
          <Button size="xs" variant="outline" onClick={() => toast.success("Access reset")}>
            <SlidersHorizontal className="size-3.5" /> Reset Access
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <DataCard>
        {filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No vendors found"
            description="No vendors match your search or filter. Try adjusting your criteria."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-10 px-3">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all" />
                </TableHead>
                <TableHead className="px-3">Vendor</TableHead>
                <TableHead className="px-3">Code</TableHead>
                <TableHead className="px-3">Company</TableHead>
                <TableHead className="px-3">Contact</TableHead>
                <TableHead className="px-3">Type</TableHead>
                <TableHead className="px-3">Portal</TableHead>
                <TableHead className="px-3">Onboarding</TableHead>
                <TableHead className="px-3">Compliance</TableHead>
                <TableHead className="px-3 text-right">Users</TableHead>
                <TableHead className="px-3">Access Profile</TableHead>
                <TableHead className="px-3">Last Login</TableHead>
                <TableHead className="w-10 px-3" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((v) => (
                <TableRow
                  key={v.id}
                  className="cursor-pointer"
                  onClick={() => setDetail(v)}
                  data-state={selected.has(v.id) ? "selected" : undefined}
                >
                  <TableCell className="px-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(v.id)}
                      onCheckedChange={() => toggleOne(v.id)}
                      aria-label={`Select ${v.name}`}
                    />
                  </TableCell>
                  <TableCell className="px-3 font-medium">{v.name}</TableCell>
                  <TableCell className="px-3 font-mono text-xs text-muted-foreground">{v.code}</TableCell>
                  <TableCell className="px-3 text-muted-foreground">{v.company}</TableCell>
                  <TableCell className="px-3">
                    <div className="grid">
                      <span>{v.contact}</span>
                      <span className="text-xs text-muted-foreground">{v.email}</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-3 text-muted-foreground">{v.type}</TableCell>
                  <TableCell className="px-3">
                    <StatusBadge status={v.portalStatus} label={PORTAL_STATUS_LABEL[v.portalStatus]} />
                  </TableCell>
                  <TableCell className="px-3">
                    <StatusBadge status={v.onboarding} label={ONBOARDING_STATUS_LABEL[v.onboarding]} />
                  </TableCell>
                  <TableCell className="px-3">
                    <StatusBadge status={v.compliance} label={COMPLIANCE_STATUS_LABEL[v.compliance]} />
                  </TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{v.users}</TableCell>
                  <TableCell className="px-3 text-muted-foreground">{v.accessProfile}</TableCell>
                  <TableCell className="px-3 text-muted-foreground">{v.lastLogin}</TableCell>
                  <TableCell className="px-3" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${v.name}`}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setDetail(v)}>
                          <Eye className="size-4" /> Open 360 view
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Invitation resent")}>
                          <Send className="size-4" /> Resend invitation
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Access reset")}>
                          <SlidersHorizontal className="size-4" /> Reset access
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => toast.success("Vendor suspended")}>
                          <Trash2 className="size-4" /> Suspend account
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataCard>

      {filtered.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {filtered.length} of {VENDORS.length} vendors
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <Vendor360Drawer vendor={detail} onClose={() => setDetail(null)} />
    </div>
  )
}
