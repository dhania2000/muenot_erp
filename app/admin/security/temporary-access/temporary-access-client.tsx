"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { Clock3, UserPlus2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/security/security-ui"

type UserRow = {
  id: number
  name: string
  email: string
  tenantRole: string
  accessExpiresAt: string | null
}

async function patchUser(id: number, body: Record<string, unknown>) {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? "Request failed")
  return data
}

export function TemporaryAccessClient({ initialUsers }: { initialUsers: UserRow[] }) {
  const [users, setUsers] = useState(initialUsers)
  const [selectedId, setSelectedId] = useState<string>("")
  const [expiresAt, setExpiresAt] = useState("")
  const [isPending, startTransition] = useTransition()

  const grantedUsers = useMemo(() => users.filter((u) => u.accessExpiresAt), [users])
  const grantCandidates = useMemo(() => users, [users])

  function handleGrant() {
    const userId = Number(selectedId)
    if (!userId || !expiresAt) {
      toast.error("Choose a user and an expiry date")
      return
    }
    const iso = new Date(expiresAt).toISOString()
    startTransition(async () => {
      try {
        const { user } = await patchUser(userId, { action: "grant_temp_access", expiresAt: iso })
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, accessExpiresAt: user.accessExpiresAt } : u)))
        setSelectedId("")
        setExpiresAt("")
        toast.success("Temporary access granted")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to grant access")
      }
    })
  }

  function handleRevoke(userId: number) {
    startTransition(async () => {
      try {
        const { user } = await patchUser(userId, { action: "revoke_temp_access" })
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, accessExpiresAt: user.accessExpiresAt } : u)))
        toast.success("Temporary access revoked")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to revoke access")
      }
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserPlus2 className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Grant temporary access</CardTitle>
          </div>
          <CardDescription>Access automatically ends at the chosen date and time.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">User</Label>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select a user" />
              </SelectTrigger>
              <SelectContent>
                {grantCandidates.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name} · {u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Expires at</Label>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="w-56"
            />
          </div>
          <Button onClick={handleGrant} disabled={isPending} className="gap-1.5">
            <Clock3 className="size-4" /> Grant access
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active temporary grants</CardTitle>
          <CardDescription>Users with a scheduled access expiry.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires at</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grantedUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="p-0">
                      <EmptyState icon={<Clock3 className="size-5" />} title="No active temporary grants">
                        Grant a user time-boxed access above to see it listed here.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  grantedUsers.map((u) => {
                    const expired = u.accessExpiresAt ? new Date(u.accessExpiresAt) < new Date() : false
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="font-medium">{u.name}</div>
                          <div className="text-xs text-muted-foreground">{u.email}</div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{u.tenantRole}</TableCell>
                        <TableCell>{u.accessExpiresAt ? new Date(u.accessExpiresAt).toLocaleString() : "—"}</TableCell>
                        <TableCell>
                          {expired ? (
                            <Badge variant="outline" className="text-muted-foreground">
                              Expired (not yet auto-enforced)
                            </Badge>
                          ) : (
                            <Badge className="border-transparent bg-emerald-600 text-white">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" disabled={isPending} onClick={() => handleRevoke(u.id)}>
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
