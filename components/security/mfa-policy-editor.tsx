"use client"

import { useMemo, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { PolicySaveBar, type SaveState } from "@/components/security/policy-save-bar"

const MODES = [
  { value: "disabled", label: "Disabled" },
  { value: "optional", label: "Optional" },
  { value: "required_all", label: "Required for all users" },
  { value: "required_admins", label: "Required for tenant admins" },
  { value: "required_roles", label: "Required for selected roles" },
] as const

type MfaMode = (typeof MODES)[number]["value"]

const ROLES = ["tenant_owner", "tenant_admin", "module_admin", "employee"]
const METHODS = [
  { id: "totp", label: "Authenticator app (TOTP)" },
  { id: "backup_codes", label: "Backup codes" },
  { id: "sms", label: "SMS (not yet supported by backend)" },
]

const RECOVERY_POLICIES = [
  { value: "self_service", label: "Users may regenerate codes anytime" },
  { value: "admin_approval", label: "Admin approval required to regenerate" },
  { value: "disabled", label: "Recovery codes disabled" },
]

type MfaPolicy = {
  mode: MfaMode
  gracePeriodDays: number
  selectedRoles: string[]
  exemptedUsers: string
  allowedMethods: string[]
  recoveryPolicy: string
}

const DEFAULT_POLICY: MfaPolicy = {
  mode: "optional",
  gracePeriodDays: 14,
  selectedRoles: [],
  exemptedUsers: "",
  allowedMethods: ["totp", "backup_codes"],
  recoveryPolicy: "self_service",
}

const MANDATORY_MODES: MfaMode[] = ["required_all", "required_admins", "required_roles"]

export function MfaPolicyEditor() {
  const [saved, setSaved] = useState<MfaPolicy>(DEFAULT_POLICY)
  const [draft, setDraft] = useState<MfaPolicy>(DEFAULT_POLICY)
  const [state, setState] = useState<SaveState>("idle")
  const [pendingMode, setPendingMode] = useState<MfaMode | null>(null)

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft])
  const effectiveState: SaveState = state === "idle" && dirty ? "dirty" : state

  function update(patch: Partial<MfaPolicy>) {
    setDraft((d) => ({ ...d, ...patch }))
    setState("idle")
  }

  function requestModeChange(mode: MfaMode) {
    if (MANDATORY_MODES.includes(mode) && !MANDATORY_MODES.includes(draft.mode)) {
      setPendingMode(mode)
    } else {
      update({ mode })
    }
  }

  function confirmModeChange() {
    if (pendingMode) update({ mode: pendingMode })
    setPendingMode(null)
  }

  function toggleInArray(arr: string[], value: string) {
    return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
  }

  async function handleSave() {
    setState("saving")
    // Frontend-only simulated save. Codex will replace this with a real
    // request to persist the tenant MFA policy.
    await new Promise((r) => setTimeout(r, 700))
    setSaved(draft)
    setState("saved")
  }

  function handleReset() {
    setDraft(saved)
    setState("idle")
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Tenant MFA policy</CardTitle>
        </div>
        <CardDescription>
          Configure multi-factor authentication requirements for this tenant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2">
          <Label htmlFor="mfa-mode">Policy mode</Label>
          <Select value={draft.mode} onValueChange={(v) => requestModeChange(v as MfaMode)}>
            <SelectTrigger id="mfa-mode" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="mfa-grace">Grace period (days)</Label>
            <Input
              id="mfa-grace"
              type="number"
              min={0}
              value={draft.gracePeriodDays}
              onChange={(e) => update({ gracePeriodDays: Number(e.target.value) || 0 })}
              disabled={draft.mode === "disabled"}
            />
            <p className="text-xs text-muted-foreground">
              Time users have to enroll before enforcement begins.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mfa-recovery">Recovery code policy</Label>
            <Select value={draft.recoveryPolicy} onValueChange={(v) => update({ recoveryPolicy: v })}>
              <SelectTrigger id="mfa-recovery" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECOVERY_POLICIES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {draft.mode === "required_roles" && (
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Selected roles</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <Checkbox
                    checked={draft.selectedRoles.includes(role)}
                    onCheckedChange={() => update({ selectedRoles: toggleInArray(draft.selectedRoles, role) })}
                  />
                  <span className="font-mono text-xs">{role}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Allowed MFA methods</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {METHODS.map((m) => (
              <label key={m.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <Checkbox
                  checked={draft.allowedMethods.includes(m.id)}
                  onCheckedChange={() => update({ allowedMethods: toggleInArray(draft.allowedMethods, m.id) })}
                />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor="mfa-exempt">Exempted users</Label>
          <Textarea
            id="mfa-exempt"
            placeholder="One email per line"
            rows={2}
            value={draft.exemptedUsers}
            onChange={(e) => update({ exemptedUsers: e.target.value })}
            disabled={draft.mode === "disabled"}
          />
          <p className="text-xs text-muted-foreground">Users listed here are excluded from enforcement.</p>
        </div>

        <PolicySaveBar state={effectiveState} onSave={handleSave} onReset={handleReset} />
      </CardContent>

      <AlertDialog open={pendingMode !== null} onOpenChange={(open) => !open && setPendingMode(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make MFA mandatory?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching to &ldquo;{MODES.find((m) => m.value === pendingMode)?.label}&rdquo; will require
              affected users to enroll in MFA before the grace period ends. Users without MFA may lose access
              once enforcement takes effect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingMode(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmModeChange}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
