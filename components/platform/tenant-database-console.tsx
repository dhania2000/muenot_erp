"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2, Database, ShieldCheck, HeartPulse, Archive, PlayCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type RegionOption = { id: string; label: string; group: string }
type RegionSettings = {
  dataRegion: string | null
  dbRegion: string | null
  storageRegion: string | null
  backupRegion: string | null
}
type ConsoleData = {
  tenant: { id: number; name: string; slug: string; deploymentModel: string }
  record: { deploymentModel: string; schema: string | null; connectionRef: string | null; status: string; region: string | null } | null
  regions: RegionSettings | null
  catalog: RegionOption[]
  allowedRegions: RegionOption[]
  audit: Array<{ id: number; action: string; status: string; createdAt: string }>
}

const NONE = "__none__"

export function TenantDatabaseConsole({
  tenantId,
  tenantName,
  onOpenChange,
}: {
  tenantId: number | null
  tenantName: string
  onOpenChange: (open: boolean) => void
}) {
  const open = tenantId !== null
  const [data, setData] = useState<ConsoleData | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [action, setAction] = useState<string | null>(null)

  // Routing form
  const [deployment, setDeployment] = useState("shared_database")
  const [schema, setSchema] = useState("")
  const [connectionRef, setConnectionRef] = useState("")

  // Region form
  const [dataRegion, setDataRegion] = useState<string>(NONE)
  const [dbRegion, setDbRegion] = useState<string>(NONE)
  const [storageRegion, setStorageRegion] = useState<string>(NONE)
  const [backupRegion, setBackupRegion] = useState<string>(NONE)

  const load = useCallback(async () => {
    if (tenantId == null) return
    setLoading(true)
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/database`)
      const json = (await res.json().catch(() => ({}))) as ConsoleData & { error?: string }
      if (!res.ok) {
        toast.error(json.error || "Could not load database settings")
        return
      }
      setData(json)
      setDeployment(json.record?.deploymentModel ?? json.tenant.deploymentModel)
      setSchema(json.record?.schema ?? "")
      setConnectionRef(json.record?.connectionRef ?? "")
      setDataRegion(json.regions?.dataRegion ?? NONE)
      setDbRegion(json.regions?.dbRegion ?? NONE)
      setStorageRegion(json.regions?.storageRegion ?? NONE)
      setBackupRegion(json.regions?.backupRegion ?? NONE)
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    if (open) {
      setData(null)
      void load()
    }
  }, [open, load])

  // The regions the residency anchor permits. Recomputed as the anchor changes
  // so the placement selectors can only offer compliant regions.
  const anchor = dataRegion === NONE ? null : dataRegion
  const allowed = data?.catalog.filter((r) => !anchor || r.group === data.catalog.find((c) => c.id === anchor)?.group) ?? []

  async function saveSettings() {
    if (tenantId == null) return
    setSaving(true)
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/database`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing: {
            deploymentModel: deployment,
            schema: schema.trim() || null,
            connectionRef: connectionRef.trim() || null,
            dbRegion: dbRegion === NONE ? null : dbRegion,
          },
          regions: {
            dataRegion: dataRegion === NONE ? null : dataRegion,
            dbRegion: dbRegion === NONE ? null : dbRegion,
            storageRegion: storageRegion === NONE ? null : storageRegion,
            backupRegion: backupRegion === NONE ? null : backupRegion,
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail =
          json.violations?.map((v: any) => v.message).join(" ") ||
          json.errors?.map((e: any) => e.message).join(" ") ||
          json.error ||
          "Could not save settings"
        toast.error(detail)
        return
      }
      toast.success("Database settings saved")
      await load()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setSaving(false)
    }
  }

  async function runAction(name: "provision" | "migrate" | "health" | "backup") {
    if (tenantId == null) return
    setAction(name)
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/database/${name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A stable per-attempt key makes retries idempotent server-side.
          "Idempotency-Key": `${name}-${tenantId}-${Date.now()}`,
        },
        body: JSON.stringify({}),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 422) {
        toast.error(`${name} failed: ${json.result?.detail ?? "unknown error"}`)
      } else if (!res.ok) {
        toast.error(json.error || `Could not run ${name}`)
      } else {
        toast.success(
          json.result?.deduplicated ? `${name}: already applied (idempotent)` : `${name}: ${json.result?.detail ?? "ok"}`,
        )
      }
      await load()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setAction(null)
    }
  }

  const needsSchema = deployment === "separate_schema" || deployment === "dedicated_database"
  const needsRef = deployment === "dedicated_database"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="size-4" />
            Database &amp; regions — {tenantName}
          </DialogTitle>
          <DialogDescription>
            Review database routing and residency. Isolated hosting activation is paused until ERP business queries,
            jobs and migrations have been verified against the tenant router. Existing tenants remain on their current
            mode; this screen does not move data.
          </DialogDescription>
        </DialogHeader>

        {loading || !data ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Current state</h3>
                <Badge variant={data.record?.status === "active" ? "default" : "secondary"} className="capitalize">
                  {data.record?.status ?? "unprovisioned"}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <span>Model: {(data.record?.deploymentModel ?? "shared_database").replace(/_/g, " ")}</span>
                <span>DB region: {data.record?.region ?? "—"}</span>
                <span>Schema: {data.record?.schema ?? "—"}</span>
                <span>Secret ref: {data.record?.connectionRef ?? "—"}</span>
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Routing</h3>
              <div className="flex flex-col gap-2">
                <Label>Deployment model</Label>
                <Select value={deployment} onValueChange={setDeployment}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shared_database">Shared database</SelectItem>
                    <SelectItem value="separate_schema" disabled={deployment !== "separate_schema"}>Separate schema (activation unavailable)</SelectItem>
                    <SelectItem value="dedicated_database" disabled={deployment !== "dedicated_database"}>Dedicated database (activation unavailable)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {needsSchema ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tdb-schema">Schema name</Label>
                  <Input id="tdb-schema" value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="tenant_acme" />
                </div>
              ) : null}
              {needsRef ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tdb-ref">Managed secret reference</Label>
                  <Input
                    id="tdb-ref"
                    value={connectionRef}
                    onChange={(e) => setConnectionRef(e.target.value)}
                    placeholder="TENANT_ACME_DSN"
                  />
                  <p className="text-xs text-muted-foreground">
                    Name of the deployment secret holding the DSN. The value is resolved server-side and never sent to the
                    browser.
                  </p>
                </div>
              ) : null}
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <ShieldCheck className="size-3.5" />
                Data residency
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <RegionSelect label="Data region (anchor)" value={dataRegion} options={data.catalog} onChange={setDataRegion} />
                <RegionSelect label="DB region" value={dbRegion} options={allowed} onChange={setDbRegion} />
                <RegionSelect label="Storage region" value={storageRegion} options={allowed} onChange={setStorageRegion} />
                <RegionSelect label="Backup region" value={backupRegion} options={allowed} onChange={setBackupRegion} />
              </div>
              {anchor ? (
                <p className="text-xs text-muted-foreground">
                  DB, storage and backup are restricted to the residency zone of the anchor region.
                </p>
              ) : null}
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Lifecycle</h3>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={action !== null} onClick={() => runAction("provision")}>
                  {action === "provision" ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
                  Provision
                </Button>
                <Button size="sm" variant="secondary" disabled={action !== null} onClick={() => runAction("migrate")}>
                  {action === "migrate" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  Migrate
                </Button>
                <Button size="sm" variant="secondary" disabled={action !== null} onClick={() => runAction("health")}>
                  {action === "health" ? <Loader2 className="size-3.5 animate-spin" /> : <HeartPulse className="size-3.5" />}
                  Health check
                </Button>
                <Button size="sm" variant="secondary" disabled={action !== null} onClick={() => runAction("backup")}>
                  {action === "backup" ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                  Back up
                </Button>
              </div>
              {data.audit.length > 0 ? (
                <ul className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  {data.audit.slice(0, 6).map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between">
                      <span>{entry.action}</span>
                      <span className="capitalize">{entry.status}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Close
          </Button>
          <Button onClick={saveSettings} disabled={loading || saving || !data}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RegionSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: RegionOption[]
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Not set" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not set</SelectItem>
          {options.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
