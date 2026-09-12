"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Search, UserPlus, Loader2, Link2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { TabState, formatDateTime } from "./shared"
import type { WhatsAppContact, WhatsAppCaps } from "./types"

/** Contact directory with server-side search + add (matches CRM leads). */
export function ContactsTab({ caps }: { caps: WhatsAppCaps | null }) {
  const [search, setSearch] = React.useState("")
  const [debounced, setDebounced] = React.useState("")

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading, mutate } = useSWR<{ contacts: WhatsAppContact[] }>(
    `/api/marketing/whatsapp/contacts?search=${encodeURIComponent(debounced)}`,
    fetcher,
  )
  const contacts = data?.contacts ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {caps?.canManageContacts ? <AddContactDialog onAdded={() => mutate()} /> : null}
      </div>

      <Card>
        <CardContent className="px-0 py-0">
          {isLoading ? (
            <TabState loading>Loading contacts…</TabState>
          ) : contacts.length === 0 ? (
            <TabState>No contacts found.</TabState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>CRM</TableHead>
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name || "Unknown"}</TableCell>
                    <TableCell className="font-mono text-xs">+{c.phone}</TableCell>
                    <TableCell>
                      {c.leadId ? (
                        <Badge variant="secondary" className="gap-1">
                          <Link2 className="size-3" /> Lead #{c.leadId}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not linked</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</TableCell>
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

function AddContactDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [phone, setPhone] = React.useState("")
  const [name, setName] = React.useState("")

  async function save() {
    if (phone.replace(/\D/g, "").length < 8) {
      toast.error("Enter a valid phone number with country code.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, name }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to add contact")
      toast.success("Contact saved")
      setPhone("")
      setName("")
      setOpen(false)
      onAdded()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><UserPlus className="size-4" /> Add contact</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a WhatsApp contact</DialogTitle>
          <DialogDescription>New contacts are automatically matched to an existing CRM lead by phone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="c-phone" className="text-xs text-muted-foreground">Phone (with country code)</Label>
            <Input id="c-phone" placeholder="e.g. 919876543210" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="c-name" className="text-xs text-muted-foreground">Name (optional)</Label>
            <Input id="c-name" placeholder="Customer name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
            Save contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
