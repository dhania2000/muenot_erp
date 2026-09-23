"use client"

import { useEffect, useMemo, useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { PolicySaveBar, type SaveState } from "@/components/security/policy-save-bar"

// Password policy editor, wired to the real backend. Reads/writes
// the same `security.*` settings that lib/password-policy.ts enforces at
// register, login, change-password, forgot-password, and admin-reset time —
// so a change here takes effect immediately, everywhere passwords are set.

type PasswordPolicy = {
  minLength: number
  requireCase: boolean
  requireNumber: boolean
  requireSymbol: boolean
  expiryDays: number
  reuseHistory: number
  maxLoginAttempts: number
  lockoutDurationMinutes: number
  tempPasswordExpiryHours: number
}

const FALLBACK_POLICY: PasswordPolicy = {
  minLength: 8,
  requireCase: true,
  requireNumber: true,
  requireSymbol: false,
  expiryDays: 90,
  reuseHistory: 5,
  maxLoginAttempts: 5,
  lockoutDurationMinutes: 15,
  tempPasswordExpiryHours: 24,
}

function buildSummary(p: PasswordPolicy): string[] {
  const lines = [`Minimum ${p.minLength} characters`]
  if (p.requireCase) lines.push("Upper & lower case required")
  if (p.requireNumber) lines.push("Number required")
  if (p.requireSymbol) lines.push("Symbol required")
  lines.push(p.expiryDays > 0 ? `Expires every ${p.expiryDays} days` : "Never expires")
  lines.push(p.reuseHistory > 0 ? `Can't reuse last ${p.reuseHistory} passwords` : "Reuse not restricted")
  lines.push(`Locks after ${p.maxLoginAttempts} failed attempts for ${p.lockoutDurationMinutes} min`)
  lines.push(`Temporary/reset passwords expire after ${p.tempPasswordExpiryHours}h`)
  lines.push("All other sessions are signed out whenever a password changes")
  return lines
}

function SwitchRow({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <label htmlFor={id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
      {label}
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}

export function PasswordPolicyEditor() {
  const [saved, setSaved] = useState<PasswordPolicy>(FALLBACK_POLICY)
  const [draft, setDraft] = useState<PasswordPolicy>(FALLBACK_POLICY)
  const [state, setState] = useState<SaveState>("idle")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch("/api/admin/security/password-policy")
      .then((r) => r.json())
      .then((data) => {
        if (!active || !data?.policy) return
        setSaved(data.policy)
        setDraft(data.policy)
      })
      .catch(() => {
        if (active) setError("Could not load the current policy — showing defaults.")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft])
  const effectiveState: SaveState = state === "idle" && dirty ? "dirty" : state

  function update(patch: Partial<PasswordPolicy>) {
    setDraft((d) => ({ ...d, ...patch }))
    setState("idle")
  }

  async function handleSave() {
    setState("saving")
    setError(null)
    try {
      const res = await fetch("/api/admin/security/password-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save policy")
      setSaved(data.policy)
      setDraft(data.policy)
      setState("saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save policy")
      setState("idle")
    }
  }

  function handleReset() {
    setDraft(saved)
    setState("idle")
    setError(null)
  }

  const summary = buildSummary(draft)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Password policy</CardTitle>
        </div>
        <CardDescription>
          Enforced at registration, sign-in, self-service change, and password reset.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading current policy…
          </p>
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="pw-min">Minimum length</Label>
                <Input
                  id="pw-min"
                  type="number"
                  min={6}
                  max={128}
                  value={draft.minLength}
                  onChange={(e) => update({ minLength: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pw-history">Password history count</Label>
                <Input
                  id="pw-history"
                  type="number"
                  min={0}
                  max={24}
                  value={draft.reuseHistory}
                  onChange={(e) => update({ reuseHistory: Number(e.target.value) || 0 })}
                />
                <p className="text-xs text-muted-foreground">Number of previous passwords a user cannot reuse.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pw-expiry">Password expiry (days)</Label>
                <Input
                  id="pw-expiry"
                  type="number"
                  min={0}
                  max={3650}
                  value={draft.expiryDays}
                  onChange={(e) => update({ expiryDays: Number(e.target.value) || 0 })}
                />
                <p className="text-xs text-muted-foreground">0 = never expires.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pw-failed">Failed login threshold</Label>
                <Input
                  id="pw-failed"
                  type="number"
                  min={1}
                  max={20}
                  value={draft.maxLoginAttempts}
                  onChange={(e) => update({ maxLoginAttempts: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pw-lockout">Lockout duration (minutes)</Label>
                <Input
                  id="pw-lockout"
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.lockoutDurationMinutes}
                  onChange={(e) => update({ lockoutDurationMinutes: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pw-temp-expiry">Temp / reset password expiry (hours)</Label>
                <Input
                  id="pw-temp-expiry"
                  type="number"
                  min={1}
                  max={168}
                  value={draft.tempPasswordExpiryHours}
                  onChange={(e) => update({ tempPasswordExpiryHours: Number(e.target.value) || 0 })}
                />
              </div>
            </div>

            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Complexity requirements</legend>
              <SwitchRow
                id="pw-case"
                label="Require upper & lower case"
                checked={draft.requireCase}
                onCheckedChange={(v) => update({ requireCase: v })}
              />
              <SwitchRow
                id="pw-number"
                label="Require number"
                checked={draft.requireNumber}
                onCheckedChange={(v) => update({ requireNumber: v })}
              />
              <SwitchRow
                id="pw-symbol"
                label="Require symbol"
                checked={draft.requireSymbol}
                onCheckedChange={(v) => update({ requireSymbol: v })}
              />
            </fieldset>

            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Password policy summary
              </p>
              <ul className="space-y-0.5 text-sm">
                {summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            <PolicySaveBar state={effectiveState} onSave={handleSave} onReset={handleReset} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
