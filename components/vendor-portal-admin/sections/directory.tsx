"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Download, Plus, UserPlus, Users } from "lucide-react"
import {
  SectionHeader,
  SearchInput,
  FilterChips,
  StatusBadge,
  RowActions,
  EmptyState,
  Panel,
  fmtDateTime,
} from "@/components/vendor-portal-admin/shared"
import { VendorDetailSheet } from "@/components/vendor-portal-admin/sections/vendor-detail-sheet"
import {
  VENDORS,
  type Vendor,
  type PortalStatus,
  PORTAL_STATUS_LABEL,
} from "@/lib/vendor-portal/admin-data"

type StatusFilter = "all" | PortalStatus

export function DirectorySection() {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("all")
  const [type, setType] = useState<string>("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<Vendor | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const types = useMemo(() => Array.from(new Set(VENDORS.map((v) => v.type))), [])

  const filtered = useMemo(() => {
    return VENDORS.filter((v) => {
      if (status !== "all" && v.portalStatus !== status) return false
      if (type !== "all" && v.type !== type) return false
      if (query) {
        const q = query.toLowerCase()
        return (
          v.name.toLowerCase().includes(q) ||
          v.code.toLowerCase().includes(q) ||
          v.contactEmail.toLowerCase().includes(q) ||
          v.contact.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [query, status, type])

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { all: VENDORS.length }
    for (const v of VENDORS) c[v.portalStatus] = (c[v.portalStatus] ?? 0) + 1
    return c
  }, [])

  const allChecked = filtered.length > 0 && filtered.every((v) => selected.has(v.id))
  const someChecked = filtered.some((v) => selected.has(v.id))

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allChecked) filtered.forEach((v) => next.delete(v.id))
      else filtered.forEach((v) => next.add(v.id))
      return next
    })
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const openVendor = (v: Vendor) => {
    setActive(v)
    setSheetOpen(true)
  }

  const statusOptions: { key: StatusFilter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: statusCounts.all },
    { key: "active", label: "Active", count: statusCounts.active },
    { key: "pending", label: "Pending", count: statusCounts.pending },
    { key: "invited", label: "Invited", count: statusCounts.invited },
    { key: "suspended", label: "Suspended", count: statusCounts.suspended },
    { key: "rejected", label: "Rejected", count: statusCounts.rejected },
    { key: "disabled", label: "Disabled", count: statusCounts.disabled },
  ]

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Vendor Directory"
        description="Every vendor with portal access. Search, filter, bulk-manage and drill into a full Vendor 360 view."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => toast.success("Directory exported (CSV)")}>
              <Download data-icon="inline-start" className="size-4" /> Export
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus data-icon="inline-start" className="size-4" /> New vendor
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search name, code, contact…" className="w-full sm:w-72" />
        <Select value={type} onValueChange={setType}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Vendor type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <FilterChips options={statusOptions} value={status} onChange={setStatus} />

      {someChecked ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <span className="text-muted-foreground">·</span>
          <Button size="sm" variant="ghost" onClick={() => toast.success("Bulk invite sent")}>
            Invite
          </Button>
          <Button size="sm" variant="ghost" onClick={() => toast.success("Access profile applied")}>
            Set profile
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => toast.success("Vendors suspended")}>
            Suspend
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <Panel>
        {filtered.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allChecked} indeterminate={someChecked && !allChecked} onCheckedChange={toggleAll} aria-label="Select all" />
                </TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Portal status</TableHead>
                <TableHead>Onboarding</TableHead>
                <TableHead>Compliance</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((v) => (
                <TableRow key={v.id} className="cursor-pointer" onClick={() => openVendor(v)}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(v.id)} onCheckedChange={() => toggleOne(v.id)} aria-label={`Select ${v.name}`} />
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{v.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {v.code} · {v.contact}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{v.type}</TableCell>
                  <TableCell>
                    <StatusBadge status={v.portalStatus} label={PORTAL_STATUS_LABEL[v.portalStatus]} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={v.onboarding} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={v.compliance} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{v.users}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDateTime(v.lastLogin)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      actions={[
                        { label: "View Vendor 360", onSelect: () => openVendor(v) },
                        { label: "Login as vendor" },
                        { label: "Reset password" },
                        { label: "Manage access" },
                        {
                          label: v.portalStatus === "suspended" ? "Reactivate" : "Suspend",
                          destructive: v.portalStatus !== "suspended",
                          separatorBefore: true,
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={<Users className="size-8" />}
            title="No vendors match your filters"
            description="Try adjusting search or status filters, or create a new vendor account."
            action={
              <Button size="sm" variant="outline" onClick={() => { setQuery(""); setStatus("all"); setType("all") }}>
                Clear filters
              </Button>
            }
          />
        )}
      </Panel>

      <VendorDetailSheet vendor={active} open={sheetOpen} onOpenChange={setSheetOpen} />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="size-4" /> Create vendor account
            </DialogTitle>
            <DialogDescription>
              Manually provision portal access. An invitation email is sent once the account is created.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              setCreateOpen(false)
              toast.success("Vendor account created and invite sent")
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="v-name">Company name</Label>
              <Input id="v-name" required placeholder="Acme Components Pvt Ltd" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="v-contact">Primary contact</Label>
                <Input id="v-contact" required placeholder="Full name" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="v-email">Contact email</Label>
                <Input id="v-email" type="email" required placeholder="name@company.com" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Vendor type</Label>
                <Select defaultValue="Manufacturer">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {types.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Access profile</Label>
                <Select defaultValue="Vendor Admin">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Vendor Admin">Vendor Admin</SelectItem>
                    <SelectItem value="Finance User">Finance User</SelectItem>
                    <SelectItem value="Invoice User">Invoice User</SelectItem>
                    <SelectItem value="Viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit">Create account</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
