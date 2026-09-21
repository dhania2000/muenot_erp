"use client"

import { useMemo, useState } from "react"
import { KeyRound } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { PolicySaveBar, type SaveState } from "@/components/security/policy-save-bar"

type PasswordPolicy = {
  minLength: number
  requireUppercase: boolean
  requireLowercase: boolean
  requireNumber: boolean
  requireSymbol: boolean
  historyCount: number
  expiryDays: number
  failedLoginThreshold: number
  lockoutMinutes: number
  resetTokenExpiryHours: number
  forceLogoutAfterReset: boolean
}

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
  historyCount: 5,
  expiryDays: 90,
  failedLoginThreshold: 5,
  lockoutMinutes: 15,
  resetTokenExpiryHours: 1,
  forceLogoutAfterReset: true,
}

function buildSummary(p: PasswordPolicy): string[] {
  const lines = [`Minimum ${p.minLength} characters`]
  if (p.requireUppercase && p.requireLowercase) lines.push("Upper & lower case required")
  else if (p.requireUppercase) lines.push("Uppercase required")
  else if (p.requireLowercase) lines.push("Lowercase required")
  if (p.requireNumber) lines.push("Number required")
  if (p.requireSymbol) lines.push("Symbol required")
  lines.push(p.expiryDays > 0 ? `Expires every ${p.expiryDays} days` : "Never expires")
  lines.push(`Can't reuse last ${p.historyCount} passwords`)
  lines.push(`Locks after ${p.failedLoginThreshold} failed attempts for ${p.lockoutMinutes} min`)
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
  const [saved, setSaved] = useState<PasswordPolicy>(DEFAULT_POLICY)
  const [draft, setDraft] = useState<PasswordPolicy>(DEFAULT_POLICY)
  const [state, setState] = useState<SaveState>("idle")

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft])
  const effectiveState: SaveState = state === "idle" && dirty ? "dirty" : state

  function update(patch: Partial<PasswordPolicy>) {
    setDraft((d) => ({ ...d, ...patch }))
    setState("idle")
  }

  async function handleSave() {
    setState("saving")
    await new Promise((r) => setTimeout(r, 700))
    setSaved(draft)
    setState("saved")
  }

  function handleReset() {
    setDraft(saved)
    setState("idle")
  }

  const summary = buildSummary(draft)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Password policy</CardTitle>
        </div>
        <CardDescription>Spec 60 — policy editor. Codex will wire enforcement at sign-in.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
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
              value={draft.historyCount}
              onChange={(e) => update({ historyCount: Number(e.target.value) || 0 })}
            />
            <p className="text-xs text-muted-foreground">Number of previous passwords a user cannot reuse.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pw-expiry">Password expiry (days)</Label>
            <Input
              id="pw-expiry"
              type="number"
              min={0}
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
              value={draft.failedLoginThreshold}
              onChange={(e) => update({ failedLoginThreshold: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pw-lockout">Lockout duration (minutes)</Label>
            <Input
              id="pw-lockout"
              type="number"
              min={1}
              value={draft.lockoutMinutes}
              onChange={(e) => update({ lockoutMinutes: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pw-reset-token">Reset token expiry (hours)</Label>
            <Input
              id="pw-reset-token"
              type="number"
              min={1}
              value={draft.resetTokenExpiryHours}
              onChange={(e) => update({ resetTokenExpiryHours: Number(e.target.value) || 0 })}
            />
          </div>
        </div>

        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Complexity requirements</legend>
          <SwitchRow
            id="pw-upper"
            label="Require uppercase"
            checked={draft.requireUppercase}
            onCheckedChange={(v) => update({ requireUppercase: v })}
          />
          <SwitchRow
            id="pw-lower"
            label="Require lowercase"
            checked={draft.requireLowercase}
            onCheckedChange={(v) => update({ requireLowercase: v })}
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
          <SwitchRow
            id="pw-force-logout"
            label="Force logout after password reset"
            checked={draft.forceLogoutAfterReset}
            onCheckedChange={(v) => update({ forceLogoutAfterReset: v })}
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
      </CardContent>
    </Card>
  )
}
