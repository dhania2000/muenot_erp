"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  UserCog,
  UserPlus,
  Send,
  MoreHorizontal,
  ShieldCheck,
  ShieldOff,
  KeyRound,
  Lock,
  Unlock,
  LogOut,
  Trash2,
  Mail,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SectionHeader, SearchInput, FilterChips, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import { PORTAL_USERS, VENDORS, ACCESS_PROFILES, type PortalUser } from "./mock-data"

type FilterKey = "all" | PortalUser["status"]

const COLUMNS: Column[] = [
  { key: "name", header: "User" },
  { key: "vendor", header: "Vendor" },
  { key: "role", header: "Role" },
  { key: "designation", header: "Designation" },
  { key: "mfa", header: "MFA" },
  { key: "lastLogin", header: "Last Login" },
  { key: "sessions", header: "Sessions", align: "right" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

const STATUS_FILTERS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "invited", label: "Invited" },
  { value: "suspended", label: "Suspended" },
  { value: "disabled", label: "Disabled" },
  { value: "locked", label: "Locked" },
]

export function UsersSection() {
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<FilterKey>("all")
  const [createOpen, setCreateOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return PORTAL_USERS.filter((u) => {
      if (q && !`${u.name} ${u.email} ${u.vendor} ${u.role}`.toLowerCase().includes(q)) return false
      if (filter !== "all" && u.status !== filter) return false
      return true
    })
  }, [search, filter])

  const filterOptions = STATUS_FILTERS.map((f) => ({
    ...f,
    count: f.value === "all" ? PORTAL_USERS.length : PORTAL_USERS.filter((u) => u.status === f.value).length,
  }))

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Vendor User Account Management"
        description="Create, invite and manage individual vendor user accounts, roles, MFA and sessions across the portal."
        icon={UserCog}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => toast.success("Invitation sent")}>
              <Send className="size-4" />
              Invite User
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger
                render={
                  <Button size="sm">
                    <UserPlus className="size-4" />
                    Create User
                  </Button>
                }
              />
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Create vendor user</DialogTitle>
                  <DialogDescription>Provision a new portal login for a vendor contact.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldInput label="Name" placeholder="Full name" />
                  <FieldInput label="Email" placeholder="name@vendor.com" type="email" />
                  <FieldInput label="Phone" placeholder="+91 …" />
                  <FieldInput label="Designation" placeholder="e.g. Finance Head" />
                  <FieldInput label="Department" placeholder="e.g. Finance" />
                  <div className="grid gap-1.5">
                    <Label>Vendor</Label>
                    <Select>
                      <SelectTrigger>
                        <SelectValue placeholder="Select vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {VENDORS.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Role</Label>
                    <Select>
                      <SelectTrigger>
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        {ACCESS_PROFILES.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Language</Label>
                    <Select defaultValue="en">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="hi">Hindi</SelectItem>
                        <SelectItem value="de">German</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Timezone</Label>
                    <Select defaultValue="ist">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ist">Asia/Kolkata</SelectItem>
                        <SelectItem value="cet">Europe/Berlin</SelectItem>
                        <SelectItem value="pst">America/Los_Angeles</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter showCloseButton>
                  <Button onClick={() => { toast.success("User created — invite email sent"); setCreateOpen(false) }}>
                    <Mail className="size-4" /> Create & invite
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search users…" />
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
      </div>

      <AdminTable
        columns={COLUMNS}
        rows={filtered}
        empty={<EmptyState icon={UserCog} title="No users found" description="No vendor users match your filters." />}
        render={(u, key) => {
          switch (key) {
            case "name":
              return (
                <div className="grid">
                  <span className="font-medium">{u.name}</span>
                  <span className="text-xs text-muted-foreground">{u.email}</span>
                </div>
              )
            case "vendor":
              return <span className="text-muted-foreground">{u.vendor}</span>
            case "role":
              return u.role
            case "designation":
              return <span className="text-muted-foreground">{u.designation}</span>
            case "mfa":
              return u.mfa ? (
                <StatusBadge tone="success" label="Enabled" />
              ) : (
                <StatusBadge tone="neutral" label="Off" />
              )
            case "lastLogin":
              return (
                <div className="grid">
                  <span className="text-muted-foreground">{u.lastLogin}</span>
                  {u.failedAttempts > 0 ? (
                    <span className="text-xs text-destructive">{u.failedAttempts} failed</span>
                  ) : null}
                </div>
              )
            case "sessions":
              return <span className="tabular-nums">{u.sessions}</span>
            case "status":
              return <StatusBadge status={u.status} label={u.status} />
            case "actions":
              return (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => toast.success("Reset link sent")}>
                      <KeyRound className="size-4" /> Send reset link
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toast.success("Invite resent")}>
                      <Send className="size-4" /> Resend invite
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toast.success("Account unlocked")}>
                      <Unlock className="size-4" /> Unlock account
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toast.success("MFA reset")}>
                      <ShieldCheck className="size-4" /> Reset MFA
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toast.success("Sessions revoked")}>
                      <LogOut className="size-4" /> Force logout
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => toast.success("Account suspended")}>
                      <Lock className="size-4" /> Suspend
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toast.success("Account deactivated")}>
                      <ShieldOff className="size-4" /> Deactivate
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => toast.success("Account deleted")}>
                      <Trash2 className="size-4" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            default:
              return null
          }
        }}
      />
    </div>
  )
}

function FieldInput({
  label,
  placeholder,
  type = "text",
}: {
  label: string
  placeholder?: string
  type?: string
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input placeholder={placeholder} type={type} />
    </div>
  )
}
