"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Loader2, Plus, ShieldCheck, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { defaultMatrix, type PermissionMatrix } from "@/lib/permission-model"
import { MatrixTable } from "@/components/hr/permission-matrix-editor"

type CustomRole = {
  id: number
  name: string
  description: string | null
  isSystem: boolean
  memberCount: number
  createdAt: string
  updatedAt: string
}

export function RolesManager() {
  const { data, isLoading, mutate } = useSWR<{ roles: CustomRole[] }>("/api/admin/roles", fetcher)
  const roles = data?.roles ?? []

  const [createOpen, setCreateOpen] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CustomRole | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Custom roles</h2>
          <p className="text-sm text-muted-foreground">
            Reusable permission templates. Assign roles to employees to grant capabilities across modules and
            actions.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New role
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : roles.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card p-10 text-center">
          <ShieldCheck className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No custom roles yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first role to start managing permissions at scale.
            </p>
          </div>
          <Button variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New role
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roles.map((role) => (
            <div key={role.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{role.name}</p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {role.description || "No description"}
                  </p>
                </div>
                <Badge variant="secondary" className="shrink-0 gap-1">
                  <Users className="size-3" />
                  {role.memberCount}
                </Badge>
              </div>
              <div className="mt-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditingRoleId(role.id)}>
                  Edit permissions
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(role)}
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Delete {role.name}</span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateRoleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          mutate()
          setCreateOpen(false)
        }}
      />

      <RoleEditorDialog
        roleId={editingRoleId}
        onClose={() => setEditingRoleId(null)}
        onSaved={() => mutate()}
      />

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete role?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.name}" will be removed from ${deleteTarget.memberCount} member(s). Their per-user permissions are not affected. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return
                const res = await fetch(`/api/admin/roles/${deleteTarget.id}`, { method: "DELETE" })
                if (res.ok) {
                  toast.success("Role deleted")
                  mutate()
                } else {
                  toast.error("Could not delete role")
                }
                setDeleteTarget(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CreateRoleDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setName("")
      setDescription("")
    }
  }, [open])

  async function create() {
    if (!name.trim()) {
      toast.error("Role name is required")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not create role")
        return
      }
      toast.success("Role created")
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New custom role</DialogTitle>
          <DialogDescription>
            Give the role a name. You can configure module and action permissions next.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="role-name">Role name</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Finance Manager"
              maxLength={120}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="role-desc">Description</Label>
            <Textarea
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for (optional)"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Create role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RoleEditorDialog({
  roleId,
  onClose,
  onSaved,
}: {
  roleId: number | null
  onClose: () => void
  onSaved: () => void
}) {
  const { data, isLoading } = useSWR<{ role: CustomRole; matrix: PermissionMatrix }>(
    roleId ? `/api/admin/roles/${roleId}` : null,
    fetcher,
  )

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [matrix, setMatrix] = useState<PermissionMatrix>(() => defaultMatrix("none"))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data) {
      setName(data.role.name)
      setDescription(data.role.description ?? "")
      setMatrix(data.matrix)
      setDirty(false)
    }
  }, [data])

  async function save() {
    if (!roleId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/roles/${roleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, matrix }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not save role")
        return
      }
      toast.success("Role saved")
      setDirty(false)
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(roleId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit role permissions</DialogTitle>
          <DialogDescription>
            Configure what this role can do across every module and action. Changes apply to all members.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-56 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-role-name">Role name</Label>
                <Input
                  id="edit-role-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setDirty(true)
                  }}
                  maxLength={120}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-role-desc">Description</Label>
                <Input
                  id="edit-role-desc"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value)
                    setDirty(true)
                  }}
                />
              </div>
            </div>

            <MatrixTable matrix={matrix} setMatrix={setMatrix} onDirty={() => setDirty(true)} />
          </div>
        )}

        <DialogFooter>
          {dirty && <span className="mr-auto self-center text-xs text-muted-foreground">Unsaved changes</span>}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !dirty}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
