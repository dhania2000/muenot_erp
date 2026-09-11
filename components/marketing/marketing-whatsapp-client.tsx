"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  MessageCircle,
  Plug,
  ExternalLink,
  Loader2,
  CheckCircle2,
  Unlink,
  Send,
  ShieldCheck,
  Phone,
  BadgeCheck,
  Gauge,
  KeyRound,
} from "lucide-react"

import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { WhatsAppInbox } from "@/components/marketing/whatsapp-inbox"
import { WhatsAppWebhookSetup } from "@/components/marketing/whatsapp-webhook-setup"

/* ------------------------------------------------------------------ */
/* Types (mirror the API shapes)                                       */
/* ------------------------------------------------------------------ */

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

type StatusResponse = {
  connected: boolean
  integration: Integration | null
}

const PREREQUISITES: string[] = [
  "You need a WhatsApp Business Account (WABA) and a dedicated phone number registered on it to use the WhatsApp Business API.",
  "You need a Meta (Facebook) developer app with the WhatsApp product added, linked to your business email.",
  "You need a permanent System User access token with the whatsapp_business_messaging and whatsapp_business_management permissions.",
]

export function MarketingWhatsAppClient() {
  const { data, isLoading, mutate } = useSWR<StatusResponse>(
    "/api/marketing/whatsapp/integration",
    fetcher,
  )

  const connected = data?.connected ?? false
  const integration = data?.integration ?? null

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Messaging"
        title="WhatsApp"
        description="Integrate your WhatsApp Business account and send template broadcasts and conversations straight from the ERP."
        action={
          connected ? (
            <SendTestDialog integration={integration!} />
          ) : (
            <IntegrateDialog onConnected={() => mutate()} />
          )
        }
      />

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking WhatsApp connection…
          </CardContent>
        </Card>
      ) : connected && integration ? (
        <ConnectedView integration={integration} onDisconnect={() => mutate()} />
      ) : (
        <IntegrateView onConnected={() => mutate()} />
      )}
    </main>
  )
}

/* ------------------------------------------------------------------ */
/* Not connected — Zoho-style "Integrate" screen + prerequisites       */
/* ------------------------------------------------------------------ */

function IntegrateView({ onConnected }: { onConnected: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-[#25D366]/10">
            <MessageCircle className="size-8 text-[#25D366]" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight">Integrate with a WhatsApp account</h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">
              Connect a WhatsApp Business account to send WhatsApp campaigns and conversations directly from your
              marketing workspace.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <IntegrateDialog onConnected={onConnected} />
            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Learn more
              <ExternalLink className="size-4" />
            </a>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prerequisites</CardTitle>
          <CardDescription>Make sure the following are ready before you connect.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-4">
            {PREREQUISITES.map((text, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{text}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Connected — account details + stats + test send                    */
/* ------------------------------------------------------------------ */

function ConnectedView({
  integration,
  onDisconnect,
}: {
  integration: Integration
  onDisconnect: () => void
}) {
  const [disconnecting, setDisconnecting] = React.useState(false)

  async function disconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/integration", { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to disconnect")
      toast.success("WhatsApp account disconnected")
      onDisconnect()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDisconnecting(false)
    }
  }

  const number = integration.displayPhoneNumber || "—"
  const name = integration.verifiedName || integration.businessName || "WhatsApp Business"

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Status" value="Connected" icon={CheckCircle2} />
        <StatCard label="Business Number" value={number} icon={Phone} />
        <StatCard label="Verified Name" value={name} icon={BadgeCheck} />
        <StatCard
          label="Quality Rating"
          value={integration.qualityRating ?? "Unknown"}
          icon={Gauge}
        />
      </div>

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
          <Badge variant="default" className="gap-1 bg-[#25D366] hover:bg-[#25D366]">
            <ShieldCheck className="size-3" />
            Active
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Separator />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <DetailRow label="WhatsApp Business Account ID" value={integration.wabaId} mono />
            <DetailRow label="Phone Number ID" value={integration.phoneNumberId} mono />
            {integration.businessName ? (
              <DetailRow label="Business" value={integration.businessName} />
            ) : null}
            <DetailRow
              label="Connected"
              value={new Date(integration.connectedAt).toLocaleString()}
            />
          </dl>
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <SendTestDialog integration={integration} />
            <RegisterNumberDialog />
            <Button variant="outline" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
              Disconnect
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Seeing{" "}
            <span className="font-mono">(#133010) Account not registered</span> when sending? This
            number hasn&apos;t been registered with the WhatsApp Cloud API yet. Click{" "}
            <span className="font-medium">Register number</span> and enter its 6-digit PIN to enable
            sending.
          </p>
        </CardContent>
      </Card>

      <WhatsAppWebhookSetup />

      <div className="flex flex-col gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Inbox</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            Reply to customers within the 24-hour service window, send approved templates to re-open a
            conversation, and link chats to CRM leads.
          </p>
        </div>
        <WhatsAppInbox />
      </div>
    </div>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "text-sm"}>{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Integrate dialog — credential form + verification                   */
/* ------------------------------------------------------------------ */

function IntegrateDialog({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({
    wabaId: "",
    phoneNumberId: "",
    accessToken: "",
    businessName: "",
  })

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
          <Button>
            <Plug className="size-4" />
            Integrate
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
          <Field
            id="wa-waba"
            label="WhatsApp Business Account (WABA) ID"
            placeholder="e.g. 102290129340398"
            value={form.wabaId}
            onChange={(v) => set("wabaId", v)}
          />
          <Field
            id="wa-phone-id"
            label="Phone Number ID"
            placeholder="e.g. 106540352242922"
            value={form.phoneNumberId}
            onChange={(v) => set("phoneNumberId", v)}
          />
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
            <p className="text-xs text-muted-foreground">
              Generated from a System User in Meta Business Settings. Stored encrypted at rest.
            </p>
          </div>
          <Field
            id="wa-business"
            label="Business name (optional)"
            placeholder="Muenot Technologies"
            value={form.businessName}
            onChange={(v) => set("businessName", v)}
          />
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

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string
  label: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Register number dialog — one-time Cloud API registration            */
/* ------------------------------------------------------------------ */

function RegisterNumberDialog() {
  const [open, setOpen] = React.useState(false)
  const [registering, setRegistering] = React.useState(false)
  const [pin, setPin] = React.useState("")

  async function register() {
    const clean = pin.trim().replace(/[^\d]/g, "")
    if (clean.length !== 6) {
      toast.error("Enter the 6-digit PIN for this number.")
      return
    }
    setRegistering(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: clean }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to register number")
      toast.success("Number registered with the WhatsApp Cloud API")
      setPin("")
      setOpen(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRegistering(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <KeyRound className="size-4" />
            Register number
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register number with Cloud API</DialogTitle>
          <DialogDescription>
              Meta requires a one-time registration before this number can send or receive messages
              through the Cloud API. This is the Cloud API two-step verification PIN and must be
              exactly 6 digits. If the number already has a Cloud API PIN, enter it; otherwise this
              sets a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-pin" className="text-xs text-muted-foreground">
              6-digit PIN
            </Label>
            <Input
              id="wa-pin"
              inputMode="numeric"
              maxLength={6}
              placeholder="e.g. 123456"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              className="font-mono tracking-widest"
            />
            <p className="text-xs text-muted-foreground">
                This is the Cloud API two-step verification PIN (6 digits) — not the &quot;Password&quot;
                from the WhatsApp app on your phone, and not your Meta account password. We never
                store it.
            </p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={register} disabled={registering}>
            {registering ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Send test dialog                                                    */
/* ------------------------------------------------------------------ */

function SendTestDialog({ integration }: { integration: Integration }) {
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
      <DialogTrigger
        render={
          <Button>
            <Send className="size-4" />
            Send Test Message
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send a test message</DialogTitle>
          <DialogDescription>
            Sent from {integration.displayPhoneNumber || integration.verifiedName || "your business number"}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wa-to" className="text-xs text-muted-foreground">
              Recipient number (with country code)
            </Label>
            <Input
              id="wa-to"
              placeholder="e.g. 919876543210"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Message type</span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "template" ? "default" : "outline"}
                onClick={() => setMode("template")}
              >
                Template (hello_world)
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "text" ? "default" : "outline"}
                onClick={() => setMode("text")}
              >
                Free text
              </Button>
            </div>
          </div>
          {mode === "text" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wa-msg" className="text-xs text-muted-foreground">
                Message
              </Label>
              <Textarea
                id="wa-msg"
                rows={3}
                placeholder="Type your message…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Free text only reaches recipients inside the 24-hour customer service window. Use a template for a
                first contact.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              The built-in <span className="font-mono">hello_world</span> template works for a first contact without
              an open conversation window.
            </p>
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
