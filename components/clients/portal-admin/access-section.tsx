"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { SectionHeader, StatusBadge } from "./shared"
import {
  ACCESS_PROFILES,
  PERMISSION_LEVELS,
  PORTAL_RESOURCE_LIST,
  type PermissionLevel,
} from "./data"
import { Copy, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react"

const DEFAULT_MATRIX: Record<string, PermissionLevel> = Object.fromEntries(
  PORTAL_RESOURCE_LIST.map((r, i) => [
    r,
    (["view", "download", "edit", "approve", "none", "create"] as PermissionLevel[])[i % 6],
  ]),
)

export function AccessSection() {
  const [profile, setProfile] = useState(ACCESS_PROFILES[0].id)
  const [matrix, setMatrix] = useState<Record<string, PermissionLevel>>(DEFAULT_MATRIX)
  const [newOpen, setNewOpen] = useState(false)

  function setLevel(resource: string, level: PermissionLevel) {
    setMatrix((prev) => ({ ...prev, [resource]: level }))
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Access & Roles"
        description="Define access profiles (roles) and the resource permission matrix that governs what portal users can do."
      />

      <Tabs defaultValue="matrix">
        <TabsList>
          <TabsTrigger value="matrix">Permission Matrix</TabsTrigger>
          <TabsTrigger value="profiles">Access Profiles</TabsTrigger>
        </TabsList>

        {/* MATRIX */}
        <TabsContent value="matrix" className="grid gap-3 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-sm">Profile</Label>
            <Select value={profile} onValueChange={setProfile}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_PROFILES.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="ml-auto" onClick={() => toast.success("Permission matrix saved")}>
              Save changes
            </Button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead className="w-56">Permission level</TableHead>
                  <TableHead>Effective</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PORTAL_RESOURCE_LIST.map((r) => (
                  <TableRow key={r}>
                    <TableCell className="font-medium">{r}</TableCell>
                    <TableCell>
                      <Select value={matrix[r]} onValueChange={(v) => setLevel(r, v as PermissionLevel)}>
                        <SelectTrigger className="h-8 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERMISSION_LEVELS.map((l) => (
                            <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {matrix[r] === "none" ? (
                        <Badge variant="outline" className="text-muted-foreground">No access</Badge>
                      ) : (
                        <Badge variant="outline" className="capitalize">{matrix[r]}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* PROFILES */}
        <TabsContent value="profiles" className="grid gap-3 pt-2">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="size-4" /> New profile
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ACCESS_PROFILES.map((p) => (
              <div key={p.id} className="flex flex-col rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <ShieldCheck className="size-5" />
                  </span>
                  {p.system ? (
                    <StatusBadge label="System" tone="neutral" />
                  ) : (
                    <StatusBadge label="Custom" tone="info" />
                  )}
                </div>
                <h3 className="mt-3 text-sm font-semibold">{p.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{p.users} users</span>
                  <span>·</span>
                  <span>{p.clients} clients</span>
                  <span>·</span>
                  <span>{p.permissions} perms</span>
                </div>
                <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-3">
                  <Button size="xs" variant="outline" onClick={() => toast.info("Edit profile")}>
                    <Pencil className="size-3.5" /> Edit
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => toast.success("Profile duplicated")}>
                    <Copy className="size-3.5" /> Duplicate
                  </Button>
                  {!p.system ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      aria-label="Delete"
                      onClick={() => toast.success("Profile deleted")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New access profile</DialogTitle>
            <DialogDescription>Create a reusable role with a permission set.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              toast.success("Access profile created")
              setNewOpen(false)
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="ap-name">Profile name</Label>
              <Input id="ap-name" placeholder="e.g. Billing Manager" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-desc">Description</Label>
              <Textarea id="ap-desc" rows={3} placeholder="What can this role do?" />
            </div>
            <div className="grid gap-2">
              <Label>Clone permissions from</Label>
              <Select defaultValue="ap4">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_PROFILES.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewOpen(false)}>Cancel</Button>
              <Button type="submit">Create profile</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
