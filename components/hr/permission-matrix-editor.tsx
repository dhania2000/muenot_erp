"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, ShieldCheck, KeyRound, Copy, Check } from "lucide-react"
import { toast } from "sonner"
import {
  PERMISSION_ACTIONS,
  PERMISSION_GROUPS,
  PERMISSION_SCOPES,
  defaultMatrix,
  type PermissionAction,
  type PermissionMatrix,
  type PermissionScope,
} from "@/lib/permission-model"

const ACTION_LABEL: Record<PermissionAction, string> = {
  add: "Add",
  view: "View",
  update: "Update",
  delete: "Delete",
}

const SCOPE_LABEL: Record<PermissionScope, string> = {
  none: "None",
  all: "All",
  added: "Added",
  owned: "Owned",
  both: "Both",
}

type LinkedUser = { id: number; email: string; role: "admin" | "employee"; status?: string; mustChangePassword?: boolean } | null

type MatrixResponse = {
  employee: { id: number; name: string }
  linkedUser: LinkedUser
  isAdminAccount: boolean
  matrix: PermissionMatrix
}

function ScopeSelect({
  value,
  onChange,
  disabled,
}: {
  value: PermissionScope
  onChange: (v: PermissionScope) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PermissionScope)} disabled={disabled}>
      <SelectTrigger
        className={`h-8 w-full min-w-[84px] text-xs ${value !== "none" ? "border-primary/40 text-foreground" : "text-muted-foreground"}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERMISSION_SCOPES.map((s) => (
          <SelectItem key={s} value={s} className="text-xs">
            {SCOPE_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PermissionMatrixEditor({
  employeeId,
  employeeName,
  isAdmin,
}: {
  employeeId: number
  employeeName: string
  isAdmin: boolean
}) {
  const { data, isLoading, mutate } = useSWR<MatrixResponse>(
    isAdmin ? `/api/hr/employees/${employeeId}/permission-matrix` : null,
    fetcher,
  )

  const [matrix, setMatrix] = useState<PermissionMatrix>(() => defaultMatrix("none"))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (data?.matrix) {
      setMatrix(data.matrix)
      setDirty(false)
    }
  }, [data?.matrix])

  const linkedUser = data?.linkedUser ?? null
  const isAdminAccount = data?.isAdminAccount ?? false
  const canEdit = Boolean(linkedUser) && !isAdminAccount

  const grantedCount = useMemo(
    () =>
      PERMISSION_GROUPS.flatMap((g) => g.modules).reduce((acc, m) => {
        const p = matrix[m.key]
        return acc + (p ? PERMISSION_ACTIONS.filter((a) => p[a] !== "none").length : 0)
      }, 0),
    [matrix],
  )

  function setCell(moduleKey: string, action: PermissionAction, scope: PermissionScope) {
    setMatrix((prev) => ({ ...prev, [moduleKey]: { ...prev[moduleKey], [action]: scope } }))
    setDirty(true)
  }

  function setAll(scope: PermissionScope) {
    setMatrix(defaultMatrix(scope))
    setDirty(true)
  }

  function setColumn(action: PermissionAction, scope: PermissionScope) {
    setMatrix((prev) => {
      const next: PermissionMatrix = {}
      for (const key of Object.keys(prev)) next[key] = { ...prev[key], [action]: scope }
      return next
    })
    setDirty(true)
  }

  function setRow(moduleKey: string, scope: PermissionScope) {
    setMatrix((prev) => ({
      ...prev,
      [moduleKey]: { add: scope, view: scope, update: scope, delete: scope },
    }))
    setDirty(true)
  }

  async function createLoginAccount() {
    setCreating(true)
    try {
      const res = await fetch(`/api/hr/employees/${employeeId}/login-account`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not create login account")
        return
      }
      if (body.tempPassword) setTempPassword(body.tempPassword)
      toast.success("Login account ready")
      mutate()
    } finally {
      setCreating(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/hr/employees/${employeeId}/permission-matrix`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrix }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Could not save permissions")
        return
      }
      toast.success("Permissions saved")
      setDirty(false)
      mutate()
    } finally {
      setSaving(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        Only administrators can view and manage permissions.
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-56 items-center justify-center rounded-lg border bg-card text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Login-account state */}
      {isAdminAccount ? (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          <ShieldCheck className="size-5 text-primary" />
          <div>
            <p className="font-medium">Administrator account</p>
            <p className="text-muted-foreground">Admins automatically have full access to every module.</p>
          </div>
        </div>
      ) : !linkedUser ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-5">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 text-primary" />
            <div>
              <p className="font-medium">No login account yet</p>
              <p className="text-sm text-muted-foreground">
                {employeeName} needs a login account before permissions can be assigned. We&apos;ll use their
                official email and generate a temporary password.
              </p>
            </div>
          </div>
          {tempPassword ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 p-3">
              <span className="text-sm">Temporary password:</span>
              <code className="rounded bg-background px-2 py-1 font-mono text-sm">{tempPassword}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(tempPassword)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <span className="w-full text-xs text-muted-foreground">
                Share this with the employee. They&apos;ll be asked to change it on first login.
              </span>
            </div>
          ) : (
            <div>
              <Button onClick={createLoginAccount} disabled={creating}>
                {creating && <Loader2 className="size-4 animate-spin" />}
                Create login account
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3 text-sm">
            <ShieldCheck className="size-5 text-primary" />
            <div>
              <p className="font-medium">Login account linked</p>
              <p className="text-muted-foreground">{linkedUser.email}</p>
            </div>
          </div>
          <Badge variant="secondary">{grantedCount} permissions granted</Badge>
        </div>
      )}

      {/* Matrix */}
      {canEdit && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Set all permissions</span>
              <div className="w-32">
                <ScopeSelect value={"none"} onChange={(v) => setAll(v)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              None = no access · All = every record · Added = records they created · Owned = records assigned to
              them · Both = added or owned
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium">Module</th>
                  {PERMISSION_ACTIONS.map((a) => (
                    <th key={a} className="px-3 py-2 font-medium">
                      <div className="flex flex-col gap-1">
                        <span>{ACTION_LABEL[a]}</span>
                        <div className="w-[92px]">
                          <ScopeSelect value={"none"} onChange={(v) => setColumn(a, v)} />
                        </div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_GROUPS.map((group) => (
                  <GroupRows
                    key={group.slug}
                    group={group}
                    matrix={matrix}
                    onCell={setCell}
                    onRow={setRow}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-3">
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            <Button onClick={save} disabled={saving || !dirty}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save permissions
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function GroupRows({
  group,
  matrix,
  onCell,
  onRow,
}: {
  group: (typeof PERMISSION_GROUPS)[number]
  matrix: PermissionMatrix
  onCell: (moduleKey: string, action: PermissionAction, scope: PermissionScope) => void
  onRow: (moduleKey: string, scope: PermissionScope) => void
}) {
  return (
    <>
      <tr className="border-b bg-muted/20">
        <td colSpan={5} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {group.label}
        </td>
      </tr>
      {group.modules.map((m) => {
        const p = matrix[m.key] ?? { add: "none", view: "none", update: "none", delete: "none" }
        return (
          <tr key={m.key} className="border-b last:border-0 hover:bg-muted/30">
            <td className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{m.label}</span>
                <Select value={"none"} onValueChange={(v) => onRow(m.key, v as PermissionScope)}>
                  <SelectTrigger className="h-6 w-6 justify-center border-none p-0 text-muted-foreground [&>svg:last-child]:hidden">
                    <span className="text-xs">···</span>
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_SCOPES.map((s) => (
                      <SelectItem key={s} value={s} className="text-xs">
                        Set row → {SCOPE_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </td>
            {PERMISSION_ACTIONS.map((a) => (
              <td key={a} className="px-3 py-2.5">
                <ScopeSelect value={p[a]} onChange={(v) => onCell(m.key, a, v)} />
              </td>
            ))}
          </tr>
        )
      })}
    </>
  )
}
