"use client"

import { useState } from "react"
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
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ROLE_KEYS, ROLE_KEY_LABELS, type DashboardScope } from "@/lib/dashboards/types"

export type SaveDialogValue = {
  name: string
  scope: DashboardScope
  roleKey: string | null
}

export function SaveDashboardDialog({
  open,
  onOpenChange,
  initial,
  canManageShared,
  saving,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: SaveDialogValue
  canManageShared: boolean
  saving: boolean
  onSubmit: (value: SaveDialogValue) => void
}) {
  const [name, setName] = useState(initial.name)
  const [scope, setScope] = useState<DashboardScope>(initial.scope)
  const [roleKey, setRoleKey] = useState<string>(initial.roleKey ?? ROLE_KEYS[0])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save dashboard</DialogTitle>
          <DialogDescription>
            Save this layout, filters and widgets so you can return to it later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="dash-name">Name</Label>
            <Input
              id="dash-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Finance overview"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dash-scope">Visibility</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as DashboardScope)}>
              <SelectTrigger id="dash-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Only me (personal)</SelectItem>
                <SelectItem value="role" disabled={!canManageShared}>
                  A specific role
                </SelectItem>
                <SelectItem value="tenant" disabled={!canManageShared}>
                  Everyone in the organization
                </SelectItem>
              </SelectContent>
            </Select>
            {!canManageShared ? (
              <p className="text-xs text-muted-foreground">
                Only administrators can share dashboards with roles or the whole organization.
              </p>
            ) : null}
          </div>
          {scope === "role" ? (
            <div className="space-y-1.5">
              <Label htmlFor="dash-role">Role</Label>
              <Select value={roleKey} onValueChange={setRoleKey}>
                <SelectTrigger id="dash-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_KEYS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_KEY_LABELS[r] ?? r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ name, scope, roleKey: scope === "role" ? roleKey : null })}
            disabled={saving || !name.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
