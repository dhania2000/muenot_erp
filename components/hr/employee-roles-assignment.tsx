"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

type RoleOption = { id: number; name: string; description: string | null; memberCount: number }

type RolesResponse = {
  employee: { id: number; name: string }
  hasLogin: boolean
  isAdminAccount: boolean
  roles: RoleOption[]
  assignedRoleIds: number[]
}

export function EmployeeRolesAssignment({ employeeId }: { employeeId: number }) {
  const { data, isLoading, mutate } = useSWR<RolesResponse>(
    `/api/hr/employees/${employeeId}/roles`,
    fetcher,
  )

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data?.assignedRoleIds) setSelected(new Set(data.assignedRoleIds))
  }, [data?.assignedRoleIds])

  const dirty = useMemo(() => {
    if (!data) return false
    const original = new Set(data.assignedRoleIds)
    if (original.size !== selected.size) return true
    for (const id of selected) if (!original.has(id)) return true
    return false
  }, [data, selected])

  if (isLoading) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border bg-card text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  if (!data) return null

  if (data.isAdminAccount) return null

  if (!data.hasLogin) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Create a login account below before assigning roles.
      </div>
    )
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/hr/employees/${employeeId}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: Array.from(selected) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not save roles")
        return
      }
      toast.success("Roles updated")
      mutate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <div>
            <p className="text-sm font-medium">Assigned roles</p>
            <p className="text-xs text-muted-foreground">
              Roles grant permissions on top of the matrix below. The most permissive access wins.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save roles
        </Button>
      </div>

      {data.roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No custom roles defined yet.{" "}
          <Link href="/admin/roles" className="text-primary underline-offset-4 hover:underline">
            Create one
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.roles.map((role) => {
            const checked = selected.has(role.id)
            return (
              <label
                key={role.id}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                  checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40"
                }`}
              >
                <Checkbox checked={checked} onCheckedChange={() => toggle(role.id)} className="mt-0.5" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{role.name}</span>
                    {checked && (
                      <Badge variant="secondary" className="shrink-0">
                        Assigned
                      </Badge>
                    )}
                  </div>
                  {role.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{role.description}</p>
                  )}
                </div>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
