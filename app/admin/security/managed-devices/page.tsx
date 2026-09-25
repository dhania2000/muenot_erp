"use client"

import { useEffect, useState, type FormEvent } from "react"
import useSWR from "swr"
import { MonitorSmartphone, Plus, Trash2, Copy, Check } from "lucide-react"
import { SecurityHeading, EmptyState } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"

type ManagedDevice = {
  id: number
  deviceId: string
  userId: number
  label: string
  status: "active" | "revoked"
  lastSeenAt: string | null
  createdAt: string
}

type DevicePolicy = { required: boolean; emergencyAccess: boolean; updatedAt: string | null }

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// Managed-device policy + enrollment. Enforcement runs in app/api/auth/login
// via lib/sign-in-protection: when `required`, a sign-in must present a valid
// verified device assertion (body.deviceAssertion or x-device-assertion header)
// bound to an active enrollment for that user.
export default function ManagedDevicesPage() {
  const { data, isLoading, mutate } = useSWR<{ policy: DevicePolicy; devices: ManagedDevice[] }>(
    "/api/admin/security/managed-devices",
    fetcher,
  )

  const [required, setRequired] = useState(false)
  const [emergencyAccess, setEmergencyAccess] = useState(false)
  const [policyPending, setPolicyPending] = useState(false)

  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState("")
  const [userId, setUserId] = useState("")
  const [saving, setSaving] = useState(false)
  const [issuedAssertion, setIssuedAssertion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (data?.policy) {
      setRequired(data.policy.required)
      setEmergencyAccess(data.policy.emergencyAccess)
    }
  }, [data])

  const devices = data?.devices ?? []

  async function savePolicy(next: { required: boolean; emergencyAccess: boolean }) {
    setPolicyPending(true)
    try {
      const res = await fetch("/api/admin/security/managed-devices", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Failed to update policy")
      }
      toast.success("Managed-device policy updated")
      mutate()
    } catch (err) {
      // revert optimistic UI on failure
      setRequired(data?.policy.required ?? false)
      setEmergencyAccess(data?.policy.emergencyAccess ?? false)
      toast.error((err as Error).message)
    } finally {
      setPolicyPending(false)
    }
  }

  async function handleEnroll(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch("/api/admin/security/managed-devices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Scopes an accidental double-submit to a single enrollment.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ label: label || undefined, userId: userId ? Number(userId) : undefined }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to enroll device")
      // The assertion is returned exactly once — surface it so the operator can
      // install it on the device before it is gone.
      setIssuedAssertion(body.assertion ?? null)
      setLabel("")
      setUserId("")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleRevoke(id: number) {
    const res = await fetch(`/api/admin/security/managed-devices/${id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Device revoked")
      mutate()
    } else {
      toast.error("Could not revoke device")
    }
  }

  function closeDialog() {
    setOpen(false)
    setIssuedAssertion(null)
    setCopied(false)
    setLabel("")
    setUserId("")
  }

  async function copyAssertion() {
    if (!issuedAssertion) return
    await navigator.clipboard.writeText(issuedAssertion)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-6">
      <SecurityHeading title="Managed devices" spec="">
        Require a verified device assertion at sign-in so only enrolled, managed devices can access this tenant.
        Revoking a device blocks its next sign-in immediately.
      </SecurityHeading>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Policy</CardTitle>
          <CardDescription>Applied at sign-in before a session is issued.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="pr-4">
              <p className="text-sm font-medium">Require a managed device</p>
              <p className="text-xs text-muted-foreground">
                Sign-in must present a valid device assertion bound to an active enrollment for that user.
              </p>
            </div>
            <Switch
              checked={required}
              disabled={isLoading || policyPending}
              onCheckedChange={(v) => {
                setRequired(v)
                savePolicy({ required: v, emergencyAccess })
              }}
              aria-label="Require a managed device"
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="pr-4">
              <p className="text-sm font-medium">Audited emergency access</p>
              <p className="text-xs text-muted-foreground">
                Let an authorized platform super admin or active break-glass grant sign in without a managed device.
                Every bypass is audited.
              </p>
            </div>
            <Switch
              checked={emergencyAccess}
              disabled={isLoading || policyPending}
              onCheckedChange={(v) => {
                setEmergencyAccess(v)
                savePolicy({ required, emergencyAccess: v })
              }}
              aria-label="Emergency access"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">Enrolled devices</CardTitle>
              <CardDescription>Active enrollments that satisfy the managed-device requirement.</CardDescription>
            </div>
            <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : closeDialog())}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 size-4" />
                  Enroll device
                </Button>
              </DialogTrigger>
              <DialogContent>
                {issuedAssertion ? (
                  <>
                    <DialogHeader>
                      <DialogTitle>Device assertion</DialogTitle>
                      <DialogDescription>
                        Copy this assertion and install it on the device now. It is shown only once and cannot be
                        retrieved later.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                      <code className="block max-h-40 overflow-auto break-all rounded-md border bg-muted p-3 text-xs">
                        {issuedAssertion}
                      </code>
                      <Button variant="outline" size="sm" onClick={copyAssertion}>
                        {copied ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
                        {copied ? "Copied" : "Copy assertion"}
                      </Button>
                    </div>
                    <DialogFooter>
                      <Button onClick={closeDialog}>Done</Button>
                    </DialogFooter>
                  </>
                ) : (
                  <form onSubmit={handleEnroll}>
                    <DialogHeader>
                      <DialogTitle>Enroll a managed device</DialogTitle>
                      <DialogDescription>
                        Issues a verified device assertion for the target user. Leave the user blank to enroll your own
                        device.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="space-y-2">
                        <Label htmlFor="label">Label</Label>
                        <Input
                          id="label"
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                          placeholder="Work laptop"
                          maxLength={190}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="userId">User ID (optional)</Label>
                        <Input
                          id="userId"
                          value={userId}
                          onChange={(e) => setUserId(e.target.value)}
                          placeholder="Your own account if left blank"
                          inputMode="numeric"
                        />
                        <p className="text-xs text-muted-foreground">
                          Must belong to this tenant. Cross-tenant enrollment is rejected.
                        </p>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={saving}>
                        {saving ? "Enrolling…" : "Enroll device"}
                      </Button>
                    </DialogFooter>
                  </form>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <EmptyState icon={<MonitorSmartphone className="size-5" />} title="No devices enrolled">
              Enroll a device to issue its verified assertion. While the policy requires a managed device, users without
              one cannot sign in unless emergency access applies.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.label}</TableCell>
                    <TableCell className="text-muted-foreground">#{d.userId}</TableCell>
                    <TableCell>
                      <Badge variant={d.status === "active" ? "default" : "secondary"}>{d.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell>
                      {d.status === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevoke(d.id)}
                          aria-label={`Revoke ${d.label}`}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
