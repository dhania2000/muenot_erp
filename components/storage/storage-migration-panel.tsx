"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowRightLeft, FolderInput, Loader2, Plus, Trash2, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { MIGRATION_MODULES, getMigrationModule } from "@/lib/storage/migration-catalog"

const ACTIVE_TARGET = "__active__"

type MigrationMapping = {
  id: number
  moduleKey: string
  moduleLabel: string
  subModuleKey: string
  subModuleLabel: string
  connectionId: number | null
  folder: string
  createdAt: string | null
}

type ConnectionOption = { id: number; name: string; providerLabel: string }

export function StorageMigrationPanel() {
  const [open, setOpen] = useState(false)
  const [mappings, setMappings] = useState<MigrationMapping[]>([])
  const [connections, setConnections] = useState<ConnectionOption[]>([])
  const [loading, setLoading] = useState(false)

  const [moduleKey, setModuleKey] = useState("")
  const [subModuleKey, setSubModuleKey] = useState("")
  const [target, setTarget] = useState<string>(ACTIVE_TARGET)
  const [folder, setFolder] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const subModules = useMemo(() => getMigrationModule(moduleKey)?.subModules ?? [], [moduleKey])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [m, c] = await Promise.all([
        fetch("/api/admin/storage/migrations").then((r) => (r.ok ? r.json() : { mappings: [] })),
        fetch("/api/admin/storage/connections").then((r) => (r.ok ? r.json() : { connections: [] })),
      ])
      setMappings(m.mappings ?? [])
      setConnections(
        (c.connections ?? []).map((x: any) => ({ id: x.id, name: x.name, providerLabel: x.providerLabel })),
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  function onModuleChange(v: string) {
    setModuleKey(v)
    setSubModuleKey("")
    setError("")
  }

  async function save() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/admin/storage/migrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleKey,
          subModuleKey,
          connectionId: target === ACTIVE_TARGET ? null : Number(target),
          folder,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Failed to save mapping")
        return
      }
      setSubModuleKey("")
      setFolder("")
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: number) {
    await fetch(`/api/admin/storage/migrations/${id}`, { method: "DELETE" })
    await load()
  }

  function targetLabel(connectionId: number | null) {
    if (connectionId == null) return "Active / managed storage"
    const conn = connections.find((c) => c.id === connectionId)
    return conn ? `${conn.name} (${conn.providerLabel})` : `Connection #${connectionId}`
  }

  const canSave = Boolean(moduleKey && subModuleKey && folder.trim())

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="size-5 text-primary" />
              Migration
            </CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Connect any module and sub-module&apos;s data from this ERP to a specific folder in your storage.
              Pick a module, its sub-module, and the destination folder to route that data.
            </CardDescription>
          </div>
          <Button size="sm" variant={open ? "outline" : "default"} onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Open"}
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-4 md:grid-cols-3">
            {/* Column 1 — Select Module */}
            <div className="grid gap-2">
              <Label>Select Module</Label>
              <Select value={moduleKey} onValueChange={(v) => onModuleChange(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a module" />
                </SelectTrigger>
                <SelectContent>
                  {MIGRATION_MODULES.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Column 2 — Sub Module */}
            <div className="grid gap-2">
              <Label>Sub Module</Label>
              <Select value={subModuleKey} onValueChange={(v) => setSubModuleKey(v ?? "")} disabled={!moduleKey}>
                <SelectTrigger>
                  <SelectValue placeholder={moduleKey ? "Choose a sub-module" : "Select a module first"} />
                </SelectTrigger>
                <SelectContent>
                  {subModules.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Column 3 — Storage Folder */}
            <div className="grid gap-2">
              <Label>Storage Folder</Label>
              {connections.length > 0 && (
                <Select value={target} onValueChange={(v) => setTarget(v ?? ACTIVE_TARGET)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ACTIVE_TARGET}>Active / managed storage</SelectItem>
                    {connections.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name} ({c.providerLabel})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="relative">
                <FolderInput className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="e.g. hr/employee-documents"
                />
              </div>
              <p className="text-xs text-muted-foreground">Folder path inside your storage bucket.</p>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div>
            <Button onClick={save} disabled={!canSave || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Connect
            </Button>
          </div>

          <Separator />

          <div>
            <h3 className="mb-2 text-sm font-medium">Connected mappings</h3>
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : mappings.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                No mappings yet. Connect a module&apos;s data to a storage folder above.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {mappings.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{m.moduleLabel}</Badge>
                        <span className="text-sm font-medium">{m.subModuleLabel}</span>
                        <ArrowRightLeft className="size-3.5 text-muted-foreground" />
                        <span className="inline-flex items-center gap-1 text-sm font-medium">
                          <FolderInput className="size-3.5 text-muted-foreground" />
                          {m.folder}
                        </span>
                      </div>
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckCircle2 className="size-3 text-emerald-600 dark:text-emerald-400" />
                        {targetLabel(m.connectionId)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(m.id)}
                      aria-label="Remove mapping"
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}
