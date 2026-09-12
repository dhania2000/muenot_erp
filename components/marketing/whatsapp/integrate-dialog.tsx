"use client"

import * as React from "react"
import { toast } from "sonner"
import { Plug, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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

/** Manual credential entry — the advanced fallback to Embedded Signup. */
export function IntegrateManuallyDialog({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({ wabaId: "", phoneNumberId: "", accessToken: "", businessName: "" })

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function connect() {
    if (!form.wabaId.trim() || !form.phoneNumberId.trim() || !form.accessToken.trim()) {
      toast.error("WABA ID, Phone Number ID and Access Token are required.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/integration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to connect WhatsApp account")
      toast.success("WhatsApp account connected")
      setForm({ wabaId: "", phoneNumberId: "", accessToken: "", businessName: "" })
      setOpen(false)
      onConnected()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <Plug className="size-4" />
            Enter credentials manually
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Integrate WhatsApp Business</DialogTitle>
          <DialogDescription>
            Paste the credentials from your Meta app dashboard. We verify them with the WhatsApp API before saving.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-waba" className="text-xs text-muted-foreground">
              WhatsApp Business Account (WABA) ID
            </Label>
            <Input id="wa-waba" placeholder="e.g. 102290129340398" value={form.wabaId} onChange={(e) => set("wabaId", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-phone-id" className="text-xs text-muted-foreground">
              Phone Number ID
            </Label>
            <Input id="wa-phone-id" placeholder="e.g. 106540352242922" value={form.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-token" className="text-xs text-muted-foreground">
              Permanent Access Token
            </Label>
            <Textarea
              id="wa-token"
              rows={3}
              placeholder="EAAG..."
              value={form.accessToken}
              onChange={(e) => set("accessToken", e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">Generated from a System User in Meta Business Settings. Stored encrypted at rest.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-business" className="text-xs text-muted-foreground">
              Business name (optional)
            </Label>
            <Input id="wa-business" placeholder="Muenot Technologies" value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={connect} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            Verify & Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
