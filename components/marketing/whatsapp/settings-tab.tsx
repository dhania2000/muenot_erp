"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { MessageCircle, ShieldCheck, ShieldAlert, Unlink, Loader2, Send } from "lucide-react"

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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { fetcher } from "@/lib/fetcher"
import { WhatsAppWebhookSetup } from "@/components/marketing/whatsapp-webhook-setup"
import { WhatsAppEmbeddedSignup } from "@/components/marketing/whatsapp-embedded-signup"
import { TabState, formatDateTime } from "./shared"
import type { ConnectionHealth, StatusResponse } from "./types"

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

/**
 * Derives a TRUTHFUL coexistence badge from the live Meta health probe — never
 * a hardcoded green pill. `health.phone.coexistence` mirrors Meta's
 * `is_on_biz_app`, and the `registration` check reflects whether Cloud API
 * messaging is actually usable (the #133010 antidote).
 */
function coexistenceBadge(health: ConnectionHealth | null) {
  const registration = health?.checks.find((c) => c.id === "registration")
  const registered = registration?.status === "ok"
  const onBizApp = health?.phone?.coexistence

  if (onBizApp === true && registered) {
    return { label: "Coexistence active", icon: ShieldCheck, className: "border-transparent bg-[#25D366] text-white" }
  }
  if (onBizApp === false || registration?.status === "error") {
    return { label: "Coexistence onboarding incomplete", icon: ShieldAlert, className: "border-transparent bg-amber-500 text-white" }
  }
  return { label: "Setup required", icon: ShieldAlert, className: "border-transparent bg-muted-foreground text-white" }
}

/** Admin settings: account details, coexistence onboarding, webhook, disconnect. */
export function SettingsTab({ role, onChanged }: { role: "admin" | "employee"; onChanged: () => void }) {
  const { data, isLoading, mutate } = useSWR<IntegrationResponse>("/api/marketing/whatsapp/integration", fetcher)
  // Live health drives the truthful coexistence/registration state. Shares the
  // SWR cache key with the workspace shell, so this is a free read.
  const { data: status, mutate: mutateStatus } = useSWR<StatusResponse>(
    "/api/marketing/whatsapp/status",
    fetcher,
  )
  const [disconnecting, setDisconnecting] = React.useState(false)

  const isAdmin = role === "admin"
  const integration = data?.integration ?? null
  const health = status?.health ?? null

  function refreshAll() {
    mutate()
    mutateStatus()
    onChanged()
  }

  async function disconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/integration", { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to disconnect")
      toast.success("WhatsApp account disconnected from the ERP")
      refreshAll()
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
  const badge = coexistenceBadge(health)
  const BadgeIcon = badge.icon
  const registration = health?.checks.find((c) => c.id === "registration")
  const subscription = health?.checks.find((c) => c.id === "subscription")
  const needsOnboarding = badge.label !== "Coexistence active"

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
          <Badge className={cn("gap-1", badge.className)}>
            <BadgeIcon className="size-3" />
            {badge.label}
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
            <Detail
              label="Cloud API messaging"
              value={
                registration?.status === "ok"
                  ? "Registered"
                  : registration?.status === "error"
                    ? "Not registered"
                    : "Unconfirmed"
              }
            />
            <Detail
              label="Webhook subscription"
              value={subscription?.status === "ok" ? "Subscribed" : subscription?.status === "warn" ? "Not subscribed" : "Unknown"}
            />
          </dl>

          {needsOnboarding ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium text-amber-700 dark:text-amber-400">
                {registration?.status === "error"
                  ? "This number is not registered on the WhatsApp Cloud API yet."
                  : "WhatsApp Business App coexistence is not confirmed yet."}
              </p>
              <p className="mt-1 text-xs text-muted-foreground text-pretty">
                Run Meta&apos;s coexistence onboarding (QR scan from the WhatsApp Business App) to enable Cloud API
                messaging. Your existing number, chats and the Business App stay intact — there is no PIN or
                registration step, and nothing is deregistered.
              </p>
            </div>
          ) : null}

          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            {isAdmin ? (
              <WhatsAppEmbeddedSignup
                onConnected={refreshAll}
                label={needsOnboarding ? "Connect WhatsApp Business App" : "Re-run coexistence onboarding"}
                variant={needsOnboarding ? "default" : "outline"}
              />
            ) : null}
            <SendTestDialog />
            {isAdmin ? <DisconnectButton disconnecting={disconnecting} onConfirm={disconnect} /> : null}
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            Coexistence keeps this number fully usable in the WhatsApp Business App while the ERP handles the same
            conversations through the Cloud API. The access token is stored encrypted and never shown. Disconnecting
            only removes the ERP integration — it never deregisters the number or touches your Meta / WhatsApp Business
            App setup.
          </p>
        </CardContent>
      </Card>

      <WhatsAppWebhookSetup />
    </div>
  )
}

/** Disconnect with an explicit confirmation — this is a destructive ERP action. */
function DisconnectButton({ disconnecting, onConfirm }: { disconnecting: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={disconnecting}>
          {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect WhatsApp from the ERP?</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            This removes the WhatsApp integration from the ERP only. It does NOT deregister the phone number, does not
            remove it from the WhatsApp Business App, and does not touch your Meta WhatsApp Business Account. You can
            reconnect any time with &ldquo;Connect WhatsApp Business App&rdquo;.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Disconnect</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
