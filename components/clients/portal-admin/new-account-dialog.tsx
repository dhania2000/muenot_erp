"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ACCESS_PROFILES } from "./data"

export function NewAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [sendInvite, setSendInvite] = useState(true)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    toast.success(sendInvite ? "Portal account created & invitation sent" : "Portal account created")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create portal account</DialogTitle>
          <DialogDescription>
            Provision portal access for a client organisation and its primary contact.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="na-company">Company / client name</Label>
            <Input id="na-company" placeholder="Acme Interiors Pvt Ltd" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="na-contact">Primary contact</Label>
              <Input id="na-contact" placeholder="Jane Doe" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="na-email">Contact email</Label>
              <Input id="na-email" type="email" placeholder="jane@acme.com" required />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Access profile</Label>
              <Select defaultValue="ap1">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_PROFILES.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Link to client record</Label>
              <Select defaultValue="new">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">Create new client</SelectItem>
                  <SelectItem value="CL-1042">CL-1042 · Acme Interiors</SelectItem>
                  <SelectItem value="CL-1088">CL-1088 · Vertex Logistics</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
            <span>
              <span className="font-medium">Send invitation email</span>
              <span className="block text-xs text-muted-foreground">The contact receives a link to set their password.</span>
            </span>
            <Switch checked={sendInvite} onCheckedChange={setSendInvite} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit">Create account</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
