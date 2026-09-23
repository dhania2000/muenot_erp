"use client"

import { useEffect, useState, type FormEvent } from "react"
import useSWR from "swr"
import { Globe, Plus, Trash2 } from "lucide-react"
import { SecurityHeading, EmptyState, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"

type IpAllowlistEntry = {
  id: number
  label: string
  cidr: string
  mode: "allow" | "block"
  scope: "all" | "admin"
  createdByName: string | null
  lastMatchedAt: string | null
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// SPEC 62 — IP allowlisting. Enforcement runs in app/api/auth/login before the
// password check once security.ip_allowlist_enabled is on for the tenant.
export default function IpAllowlistPage() {
  const { data, isLoading, mutate } = useSWR<{
    entries: IpAllowlistEntry[]
    enabled: boolean
    emergencyBypass: boolean
  }>("/api/admin/security/ip-allowlist", fetcher)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [label, setLabel] = useState("")
  const [cidr, setCidr] = useState("")
  const [mode, setMode] = useState<"allow" | "block">("allow")
  const [scope, setScope] = useState<"all" | "admin">("all")
  const [togglePending, setTogglePending] = useState(false)
  const [localEnabled, setLocalEnabled] = useState(false)

  useEffect(() => {
    if (data) setLocalEnabled(data.enabled)
  }, [data])

  const entries = data?.entries ?? []

  async function handleToggle(next: boolean) {
    setLocalEnabled(next)
    setTogglePending(true)
    try {
      const res = await fetch("/api/admin/security/ip-allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error("Failed to update")
      toast.success(next ? "IP allowlist enforcement enabled" : "IP allowlist enforcement disabled")
      mutate()
    } catch {
      setLocalEnabled(!next)
      toast.error("Could not update enforcement")
    } finally {
      setTogglePending(false)
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch("/api/admin/security/ip-allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, cidr, mode, scope }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to create entry")
      toast.success("IP range added")
      setOpen(false)
      setLabel("")
      setCidr("")
      setMode("allow")
      setScope("all")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    const res = await fetch(`/api/admin/security/ip-allowlist/${id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Entry removed")
      mutate()
    } else {
      toast.error("Could not remove entry")
    }
  }

  return (
    <div className="space-y-6">
      <SecurityHeading title="IP allowlist" spec="Spec 62">
        Restrict sign-in to specific IP ranges. When enabled, requests outside the allowlist are blocked before a
        session is issued.
      </SecurityHeading>

      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="space-y-0.5">
            <Label htmlFor="ip-enforcement" className="text-sm font-medium">
              Enforce IP allowlist at sign-in
            </Label>
            <p className="text-xs text-muted-foreground">
              When on, sign-in requests are checked against the ranges below before credentials are verified.
            </p>
          </div>
          <Switch id="ip-enforcement" checked={localEnabled} disabled={togglePending} onCheckedChange={handleToggle} />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {localEnabled
            ? "Enforcement is on. Sign-ins outside these ranges are blocked."
            : "Enforcement is off. Entries are saved but not yet checked at sign-in."}
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button className="gap-1.5">
                <Plus className="size-4" /> Add IP range
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add IP range</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ip-label">Label</Label>
                <Input id="ip-label" value={label} onChange={(e) => setLabel(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ip-cidr">CIDR range</Label>
                <Input
                  id="ip-cidr"
                  placeholder="203.0.113.0/24"
                  value={cidr}
                  onChange={(e) => setCidr(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Mode</Label>
                  <Select value={mode} onValueChange={(v) => setMode(v as "allow" | "block")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">Allow</SelectItem>
                      <SelectItem value="block">Block</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Applies to</Label>
                  <Select value={scope} onValueChange={(v) => setScope(v as "all" | "admin")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sign-ins</SelectItem>
                      <SelectItem value="admin">Admin console only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={saving}>
                  {saving ? "Adding..." : "Add range"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Allowed ranges</CardTitle>
          </div>
          <CardDescription>label · CIDR range · mode · scope · created by · last matched</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>CIDR range</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Applies to</TableHead>
                  <TableHead>Last matched</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState icon={<Globe className="size-5" />} title="No IP ranges configured">
                        Add a range above, then turn on enforcement once you&apos;re confident the list is
                        correct.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">{entry.label}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.cidr}</TableCell>
                      <TableCell className="capitalize">{entry.mode}</TableCell>
                      <TableCell className="capitalize">{entry.scope === "all" ? "All sign-ins" : "Admin only"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.lastMatchedAt ? new Date(entry.lastMatchedAt).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(entry.id)}>
                          <Trash2 className="size-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Entry fields</CardTitle>
          <CardDescription>Spec 62 — captured per range.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Label" />
            <FieldSpec label="CIDR range" hint="e.g. 203.0.113.0/24" />
            <FieldSpec label="Mode" hint="Allow or block" />
            <FieldSpec label="Applies to" hint="All sign-ins or admin console only" />
            <FieldSpec label="Created by" />
            <FieldSpec label="Last matched" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
