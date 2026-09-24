"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState, KpiCard, SearchInput, SectionHeader, StatusBadge, portalStatusTone } from "./shared"
import { ACCESS_PROFILES, CLIENTS, INVITATIONS } from "./data"
import { MailPlus, MoreHorizontal, Send } from "lucide-react"

export function InvitationsSection() {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return INVITATIONS.filter((i) => {
      if (status !== "all" && i.status !== status) return false
      if (!q) return true
      return [i.recipient, i.client, i.role].some((v) => v.toLowerCase().includes(q))
    })
  }, [query, status])

  const counts = {
    pending: INVITATIONS.filter((i) => i.status === "pending").length,
    accepted: INVITATIONS.filter((i) => i.status === "accepted").length,
    expired: INVITATIONS.filter((i) => i.status === "expired").length,
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Invitations"
        description="Track and manage portal invitations sent to client contacts."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <MailPlus className="size-4" /> Send invitation
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Pending" value={counts.pending} tone="warning" />
        <KpiCard label="Accepted" value={counts.accepted} tone="positive" />
        <KpiCard label="Expired" value={counts.expired} tone="danger" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search invitations…" className="w-full sm:w-72" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="accepted">Accepted</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Send} title="No invitations" description="Invite a client contact to give them portal access." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.recipient}</TableCell>
                  <TableCell className="text-sm">{i.client}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{i.role}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{i.sent}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{i.expires}</TableCell>
                  <TableCell>
                    <StatusBadge label={i.status} tone={portalStatusTone(i.status)} className="capitalize" />
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => toast.success("Invitation resent")}>Resend</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Link copied")}>Copy link</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toast.success("Invitation revoked")}>Revoke</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send invitation</DialogTitle>
            <DialogDescription>Invite a client contact to the portal.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              toast.success("Invitation sent")
              setOpen(false)
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="iv-email">Recipient email</Label>
              <Input id="iv-email" type="email" placeholder="name@company.com" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Client</Label>
                <Select defaultValue={CLIENTS[0].name}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLIENTS.map((c) => (
                      <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Role</Label>
                <Select defaultValue={ACCESS_PROFILES[0].name}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCESS_PROFILES.map((p) => (
                      <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-msg">Personal message (optional)</Label>
              <Textarea id="iv-msg" rows={3} placeholder="Add a short note to the invitation email…" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit">Send invitation</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
