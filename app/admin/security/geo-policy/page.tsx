"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Globe, ShieldAlert } from "lucide-react"
import { SecurityHeading } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"

type GeoPolicy = {
  enabled: boolean
  mode: "allow" | "block"
  countries: string[]
  unknownAction: "block" | "allow"
  emergencyAccess: boolean
  updatedAt: string | null
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// Tenant country (geo) policy. Enforcement runs in app/api/auth/login via
// lib/sign-in-protection after the password check, against a TRUSTED country
// resolved by lib/geo-trust. Unknown/VPN locations follow `unknownAction`.
export default function GeoPolicyPage() {
  const { data, isLoading, mutate } = useSWR<{ policy: GeoPolicy; geoSource: string }>(
    "/api/admin/security/geo-policy",
    fetcher,
  )

  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState<"allow" | "block">("allow")
  const [countries, setCountries] = useState("")
  const [unknownAction, setUnknownAction] = useState<"block" | "allow">("block")
  const [emergencyAccess, setEmergencyAccess] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data?.policy) {
      setEnabled(data.policy.enabled)
      setMode(data.policy.mode)
      setCountries(data.policy.countries.join(", "))
      setUnknownAction(data.policy.unknownAction)
      setEmergencyAccess(data.policy.emergencyAccess)
    }
  }, [data])

  const geoSource = data?.geoSource ?? "none"
  const untrusted = geoSource === "none"

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/security/geo-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, mode, countries, unknownAction, emergencyAccess }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to save policy")
      toast.success("Country policy saved")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SecurityHeading title="Country policy" spec="">
        Allow or block sign-in by country using a trusted IP geolocation resolved at the edge. A VPN, proxy or
        unresolvable location is treated as unknown and follows your fail-safe choice below.
      </SecurityHeading>

      {untrusted && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="text-muted-foreground">
              No trusted geolocation source is configured for this deployment, so every location resolves as{" "}
              <span className="font-medium">unknown</span>. Set{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">GEO_TRUSTED_SOURCE</code> (e.g. {`"vercel"`} or{" "}
              {`"cloudflare"`}) for country matching to take effect. Until then only the unknown-location rule applies.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">Enforce country policy</CardTitle>
              <CardDescription>
                When enabled, sign-in is evaluated against the rule below before a session is issued.
              </CardDescription>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={isLoading} aria-label="Enforce country policy" />
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "allow" | "block")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow-list — permit only listed countries</SelectItem>
                  <SelectItem value="block">Block-list — deny listed countries</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>When location is unknown (VPN / proxy)</Label>
              <Select value={unknownAction} onValueChange={(v) => setUnknownAction(v as "block" | "allow")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">Block (fail-closed, recommended)</SelectItem>
                  <SelectItem value="allow">Allow (fail-open)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="countries">Countries</Label>
            <Textarea
              id="countries"
              value={countries}
              onChange={(e) => setCountries(e.target.value)}
              placeholder="US, GB, IN, DE"
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              ISO 3166-1 alpha-2 codes, comma or space separated. An enabled allow-list must contain at least one
              country. Invalid codes are dropped on save.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="pr-4">
              <p className="text-sm font-medium">Audited emergency access</p>
              <p className="text-xs text-muted-foreground">
                Let an authorized platform super admin or an active break-glass grant bypass a geo denial. Every bypass
                is written to the security audit trail.
              </p>
            </div>
            <Switch checked={emergencyAccess} onCheckedChange={setEmergencyAccess} aria-label="Emergency access" />
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Trusted source: <span className="font-medium">{geoSource}</span>
              {data?.policy.updatedAt ? ` · updated ${new Date(data.policy.updatedAt).toLocaleString()}` : ""}
            </p>
            <Button onClick={handleSave} disabled={saving || isLoading}>
              <Globe className="mr-2 size-4" />
              {saving ? "Saving…" : "Save policy"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
