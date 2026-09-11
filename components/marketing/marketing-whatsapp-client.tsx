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
import { WhatsAppEmbeddedSignup } from "@/components/marketing/whatsapp-embedded-signup"

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
  platformType: string | null
  coexistence: boolean
  connectedAt: string
}

type StatusResponse = {
  connected: boolean
  integration: Integration | null
}

const PREREQUISITES: string[] = [
  "Keep using the WhatsApp Business App on the number you want to connect — coexistence onboarding preserves that number, its chats and its app; it never replaces or deregisters it.",
  "Have the phone with the WhatsApp Business App handy: you will scan a QR code from within the app (Settings → Linked devices) to finish connecting.",
  "Sign in with the Meta (Facebook) account that manages, or can create, the WhatsApp Business Account for this number when the guided popup asks.",
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
            <ConnectActions onConnected={() => mutate()} />
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
/* Connect actions — Embedded Signup (primary) + manual fallback       */
/* ------------------------------------------------------------------ */

/**
 * The connect controls shown in the page header. Meta's guided Embedded Signup
 * is the primary path (coexistence QR onboarding — no credentials to copy);
 * the manual credential dialog stays available as an advanced fallback.
 */
function ConnectActions({ onConnected }: { onConnected: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <WhatsAppEmbeddedSignup onConnected={onConnected} />
      <IntegrateDialog onConnected={onConnected} label="Enter credentials manually" variant="outline" />
    </div>
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
              marketing workspace. The guided setup runs Meta&apos;s coexistence onboarding — keep using the
              WhatsApp Business App on the same number.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <WhatsAppEmbeddedSignup onConnected={onConnected} />
            <IntegrateDialog onConnected={onConnected} label="Enter credentials manually" variant="outline" />
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
            <Button variant="outline" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
              Disconnect
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            This number runs in WhatsApp Coexistence: it stays fully usable in the WhatsApp Business
            App while the ERP handles the same conversations through the Cloud API. There is no
            registration step or PIN — messages sync automatically once Meta&apos;s webhook is
            subscribed.
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

function IntegrateDialog({
  onConnected,
  label = "Integrate",
  variant = "default",
}: {
  onConnected: () => void
  label?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
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
          <Button variant={variant}>
            <Plug className="size-4" />
            {label}
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
