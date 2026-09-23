"use client"

// Platform-wide audit retention policy. Sets the DEFAULT retention
// window applied to tenants without an override, and the compliance FLOOR no
// tenant may drop below. Also governs the platform-wide audit rows.
import { useState } from "react"
import useSWR, { mutate as globalMutate } from "swr"
import { toast } from "sonner"
import { ShieldCheckIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Field, FieldLabel } from "@/components/ui/field"
import { describeRetention } from "@/lib/audit-retention-policy"

const ENDPOINT = "/api/platform/audit-retention"

type PlatformPolicy = {
  defaultRetentionDays: number
  minRetentionDays: number
  archiveEnabled: boolean
  purgeAfterArchive: boolean
}

type Summary = {
  liveEntries: number
  eligibleForArchive: number
  archivedEntries: number
  archivedBatches: number
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to load platform audit retention")
    return r.json() as Promise<{ policy: PlatformPolicy; summary: Summary }>
  })

export function AuditRetentionPlatformPanel() {
  const { data, isLoading } = useSWR(ENDPOINT, fetcher)

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />

  return <PolicyForm policy={data.policy} summary={data.summary} />
}

function PolicyForm({ policy, summary }: { policy: PlatformPolicy; summary: Summary }) {
  const [defaultDays, setDefaultDays] = useState(String(policy.defaultRetentionDays))
  const [minDays, setMinDays] = useState(String(policy.minRetentionDays))
  const [archiveEnabled, setArchiveEnabled] = useState(policy.archiveEnabled)
  const [purgeAfterArchive, setPurgeAfterArchive] = useState(policy.purgeAfterArchive)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultRetentionDays: Number(defaultDays),
          minRetentionDays: Number(minDays),
          archiveEnabled,
          purgeAfterArchive,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Save failed")
      toast.success("Platform audit retention saved")
      globalMutate(ENDPOINT)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-muted-foreground" />
          Audit log retention
        </CardTitle>
        <CardDescription>
          Platform default and compliance floor for every tenant&apos;s immutable audit trail. Platform-wide rows keep
          the default. Currently {summary.liveEntries.toLocaleString()} platform-wide live entries,{" "}
          {summary.archivedEntries.toLocaleString()} archived across {summary.archivedBatches} batches.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="platform-default-days">Default retention (days)</FieldLabel>
            <Input id="platform-default-days" type="number" value={defaultDays} onChange={(e) => setDefaultDays(e.target.value)} />
            <span className="text-xs text-muted-foreground">
              {Number.isFinite(Number(defaultDays)) ? `≈ ${describeRetention(Number(defaultDays))}` : ""} · applied to tenants with no override
            </span>
          </Field>
          <Field>
            <FieldLabel htmlFor="platform-min-days">Minimum floor (days)</FieldLabel>
            <Input id="platform-min-days" type="number" value={minDays} onChange={(e) => setMinDays(e.target.value)} />
            <span className="text-xs text-muted-foreground">
              {Number.isFinite(Number(minDays)) ? `≈ ${describeRetention(Number(minDays))}` : ""} · no tenant may retain less
            </span>
          </Field>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col">
              <Label htmlFor="platform-archive">Archive by default</Label>
              <span className="text-xs text-muted-foreground">New tenants seal aged entries into the immutable archive.</span>
            </div>
            <Switch id="platform-archive" checked={archiveEnabled} onCheckedChange={setArchiveEnabled} />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col">
              <Label htmlFor="platform-purge">Purge originals by default</Label>
              <span className="text-xs text-muted-foreground">Remove sealed originals from the hot log (never under legal hold).</span>
            </div>
            <Switch id="platform-purge" checked={purgeAfterArchive} onCheckedChange={setPurgeAfterArchive} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save platform policy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
