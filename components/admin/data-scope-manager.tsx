"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Plus, ShieldCheck, X } from "lucide-react"
import { toast } from "sonner"
import type { DataScopeKind } from "@/lib/data-scope-model"

type DomainMeta = { key: string; label: string }
type KindMeta = { value: DataScopeKind; label: string; description: string; example: string }
type Catalog = {
  domains: DomainMeta[]
  kinds: KindMeta[]
  suggestions: { entities: string[]; branches: string[] }
}
type EmployeeRow = { id: number; name: string; email: string; role: string }
type UserConfig = {
  grants: Record<string, DataScopeKind>
  assignments: { entities: string[]; branches: string[] }
}

const INHERIT = "__inherit__"

export function DataScopeManager() {
  const { data: catalog } = useSWR<Catalog>("/api/admin/data-scopes", fetcher)
  const { data: employeesData } = useSWR<{ employees: EmployeeRow[] }>("/api/admin/employees", fetcher)

  const employees = useMemo(
    () => (employeesData?.employees ?? []).filter((e) => e.role !== "admin"),
    [employeesData],
  )

  const [userId, setUserId] = useState<string>("")
  const [grants, setGrants] = useState<Record<string, DataScopeKind>>({})
  const [entities, setEntities] = useState<string[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [entityDraft, setEntityDraft] = useState("")
  const [branchDraft, setBranchDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    fetcher(`/api/admin/data-scopes/${userId}`)
      .then((cfg: UserConfig) => {
        if (cancelled) return
        setGrants(cfg.grants ?? {})
        setEntities(cfg.assignments?.entities ?? [])
        setBranches(cfg.assignments?.branches ?? [])
      })
      .catch(() => toast.error("Could not load this user's data scopes"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [userId])

  const usesEntity = Object.values(grants).includes("entity")
  const usesBranch = Object.values(grants).includes("branch")

  function setDomainKind(domain: string, value: string) {
    setGrants((prev) => {
      const next = { ...prev }
      if (value === INHERIT) delete next[domain]
      else next[domain] = value as DataScopeKind
      return next
    })
  }

  function addValue(kind: "entity" | "branch") {
    const draft = (kind === "entity" ? entityDraft : branchDraft).trim()
    if (!draft) return
    const setter = kind === "entity" ? setEntities : setBranches
    setter((prev) => (prev.includes(draft) ? prev : [...prev, draft]))
    if (kind === "entity") setEntityDraft("")
    else setBranchDraft("")
  }

  function removeValue(kind: "entity" | "branch", value: string) {
    const setter = kind === "entity" ? setEntities : setBranches
    setter((prev) => prev.filter((v) => v !== value))
  }

  async function save() {
    if (!userId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/data-scopes/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grants, assignments: { entities, branches } }),
      })
      if (!res.ok) throw new Error()
      toast.success("Data scopes saved")
    } catch {
      toast.error("Failed to save data scopes")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="size-5 text-muted-foreground" aria-hidden />
            Data-level access
          </CardTitle>
          <CardDescription>
            Grant each user record-level visibility per data domain — own records, their team (report chain),
            their assigned entities or branches, or the whole platform. Layers on top of role permissions: a user
            only ever sees the intersection of what their role and their data scope both allow. Leave a domain on
            <span className="font-medium"> Inherit</span> to keep the current unrestricted behaviour.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:max-w-sm">
            <Label htmlFor="ds-user">User</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger id="ds-user">
                <SelectValue placeholder="Select a user to configure" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.name} · {e.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {userId && loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading configuration…
            </div>
          ) : null}
        </CardContent>
      </Card>

      {userId && !loading ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Domain scopes</CardTitle>
              <CardDescription>Choose how much of each domain this user can see.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y">
              {(catalog?.domains ?? []).map((d) => {
                const current = grants[d.key] ?? INHERIT
                const meta = catalog?.kinds.find((k) => k.value === current)
                return (
                  <div key={d.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-medium">{d.label}</p>
                      {meta ? <p className="text-sm text-muted-foreground">{meta.description}</p> : null}
                    </div>
                    <Select value={current} onValueChange={(v) => setDomainKind(d.key, v)}>
                      <SelectTrigger className="sm:w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>Inherit (unrestricted)</SelectItem>
                        {(catalog?.kinds ?? []).map((k) => (
                          <SelectItem key={k.value} value={k.value}>
                            {k.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {(usesEntity || usesBranch) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Assignments</CardTitle>
                <CardDescription>
                  Entity / branch scopes only expose records whose entity or branch matches one of these values.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                {usesEntity && (
                  <AssignmentEditor
                    label="Assigned entities"
                    values={entities}
                    draft={entityDraft}
                    setDraft={setEntityDraft}
                    onAdd={() => addValue("entity")}
                    onRemove={(v) => removeValue("entity", v)}
                    suggestions={catalog?.suggestions.entities ?? []}
                    onPick={(v) => setEntities((prev) => (prev.includes(v) ? prev : [...prev, v]))}
                  />
                )}
                {usesBranch && (
                  <AssignmentEditor
                    label="Assigned branches"
                    values={branches}
                    draft={branchDraft}
                    setDraft={setBranchDraft}
                    onAdd={() => addValue("branch")}
                    onRemove={(v) => removeValue("branch", v)}
                    suggestions={catalog?.suggestions.branches ?? []}
                    onPick={(v) => setBranches((prev) => (prev.includes(v) ? prev : [...prev, v]))}
                  />
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Save data scopes
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function AssignmentEditor({
  label,
  values,
  draft,
  setDraft,
  onAdd,
  onRemove,
  suggestions,
  onPick,
}: {
  label: string
  values: string[]
  draft: string
  setDraft: (v: string) => void
  onAdd: () => void
  onRemove: (v: string) => void
  suggestions: string[]
  onPick: (v: string) => void
}) {
  const available = suggestions.filter((s) => !values.includes(s)).slice(0, 12)
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {values.length === 0 ? (
          <span className="text-sm text-muted-foreground">None assigned yet.</span>
        ) : (
          values.map((v) => (
            <Badge key={v} variant="secondary" className="gap-1">
              {v}
              <button type="button" onClick={() => onRemove(v)} aria-label={`Remove ${v}`} className="ml-1">
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add ${label.toLowerCase()}…`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onAdd()
            }
          }}
        />
        <Button type="button" variant="outline" size="icon" onClick={onAdd} aria-label={`Add ${label.toLowerCase()}`}>
          <Plus className="size-4" aria-hidden />
        </Button>
      </div>
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {available.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-solid hover:text-foreground"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
