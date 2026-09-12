"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { MessageCircle, ShieldCheck, Unlink, Loader2, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
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
import { WhatsAppWebhookSetup } from "@/components/marketing/whatsapp-webhook-setup"
import { TabState, formatDateTime } from "./shared"

type Integration = {
  id: number
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string | null
  verifiedName: string | null
  businessName: string | null
  qualityRating: string | null
  connectedAt: string
}

type IntegrationResponse = { connected: boolean; integration: Integration | null }

/** Admin settings: account details, webhook + WABA subscription, disconnect. */
export function SettingsTab({ role, onChanged }: { role: "admin" | "employee"; onChanged: () => void }) {
  const { data, isLoading, mutate } = useSWR<IntegrationResponse>("/api/marketing/whatsapp/integration", fetcher)
  const [disconnecting, setDisconnecting] = React.useState(false)

  const isAdmin = role === "admin"
  const integration = data?.integration ?? null

  async function disconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/integration", { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to disconnect")
      toast.success("WhatsApp account disconnected")
      mutate()
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDisconnecting(false)
    }
  }

  if (isLoading) return <TabState loading>Loading settings…</TabState>
  if (!integration) return <TabState>No WhatsApp account is connected.</TabState>

  const number = integration.displayPhoneNumber || "—"
  const name = integration.verifiedName || integration.businessName || "WhatsApp Business"

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-[#25D366]/10">
              <MessageCircle className="size-5 text-[#25D366]" />
            </div>
            <div>
              <CardTitle className="text-base">{name}</CardTitle>
              <CardDescription>{number}</CardDescription>
            </div>
          </div>
          <Badge className="gap-1 border-transparent bg-[#25D366] text-white">
            <ShieldCheck className="size-3" />
            Coexistence
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Separator />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="WABA ID" value={integration.wabaId} mono />
            <Detail label="Phone Number ID" value={integration.phoneNumberId} mono />
            <Detail label="Verified name" value={name} />
            <Detail label="Quality rating" value={integration.qualityRating ?? "Unknown"} />
            {integration.businessName ? <Detail label="Business" value={integration.businessName} /> : null}
            <Detail label="Connected" value={formatDateTime(integration.connectedAt)} />
          </dl>
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <SendTestDialog />
            {isAdmin ? (
              <Button variant="outline" onClick={disconnect} disabled={disconnecting}>
                {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
                Disconnect
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            This number runs in WhatsApp Coexistence: it stays fully usable in the WhatsApp Business App while the ERP
            handles the same conversations through the Cloud API. The access token is stored encrypted and never shown.
          </p>
        </CardContent>
      </Card>

      <WhatsAppWebhookSetup />
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "text-sm"}>{value}</dd>
    </div>
  )
}

function SendTestDialog() {
  const [open, setOpen] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [mode, setMode] = React.useState<"template" | "text">("template")
  const [to, setTo] = React.useState("")
  const [message, setMessage] = React.useState("")

  async function send() {
    if (!to.trim()) {
      toast.error("Enter a recipient number with country code.")
      return
    }
    setSending(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "template"
            ? { to, mode: "template", templateName: "hello_world", languageCode: "en_US" }
            : { to, mode: "text", message },
        ),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to send message")
      toast.success("Message sent to WhatsApp")
      setTo("")
      setMessage("")
      setOpen(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Send className="size-4" /> Send test message</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send a test message</DialogTitle>
          <DialogDescription>Verify the Cloud API end-to-end from your connected number.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-to" className="text-xs text-muted-foreground">Recipient number (with country code)</Label>
            <Input id="wa-to" placeholder="e.g. 919876543210" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Message type</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={mode === "template" ? "default" : "outline"} onClick={() => setMode("template")}>
                Template (hello_world)
              </Button>
              <Button type="button" size="sm" variant={mode === "text" ? "default" : "outline"} onClick={() => setMode("text")}>
                Free text
              </Button>
            </div>
          </div>
          {mode === "text" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wa-msg" className="text-xs text-muted-foreground">Message</Label>
              <Textarea id="wa-msg" rows={3} placeholder="Type your message…" value={message} onChange={(e) => setMessage(e.target.value)} />
              <p className="text-xs text-muted-foreground">Free text only reaches recipients inside the 24-hour service window.</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Sends the built-in hello_world template — works for a first contact.</p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={send} disabled={sending}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
