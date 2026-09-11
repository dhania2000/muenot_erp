"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Webhook, Copy, Check, ShieldCheck, ShieldAlert, Loader2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { fetcher } from "@/lib/fetcher"

/* ------------------------------------------------------------------ */
/* Types (mirror /api/marketing/whatsapp/webhook-config)               */
/* ------------------------------------------------------------------ */

type WebhookConfig = {
  callbackUrl: string
  verifyTokenConfigured: boolean
  verifyTokenMasked: string | null
  appSecretConfigured: boolean
  subscribeField: string
}

/**
 * "Webhook setup" panel shown on the connected WhatsApp screen. It surfaces the
 * exact callback URL to paste into Meta, whether the server-side secrets are in
 * place (never revealing them), and a button to subscribe the WABA so inbound
 * messages actually start flowing into the inbox.
 */
export function WhatsAppWebhookSetup() {
  const { data, isLoading } = useSWR<WebhookConfig>(
    "/api/marketing/whatsapp/webhook-config",
    fetcher,
  )
  const [subscribing, setSubscribing] = React.useState(false)

  async function subscribe() {
    setSubscribing(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/webhook-config", { method: "POST" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to subscribe to webhooks")
      toast.success("Subscribed — inbound messages will now arrive in the inbox")
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubscribing(false)
    }
  }

  const ready = Boolean(data?.verifyTokenConfigured && data?.appSecretConfigured)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Webhook className="size-5 text-muted-foreground" />
          </div>
          <div>
            <CardTitle className="text-base">Webhook setup</CardTitle>
            <CardDescription>
              Point Meta at this callback so inbound messages and delivery receipts reach the inbox.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading || !data ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading webhook configuration…
          </div>
        ) : (
          <>
            <CopyRow label="Callback URL" value={data.callbackUrl} />
            <CopyRow label="Subscribed field" value={data.subscribeField} copyable={false} />

            <Separator />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatusRow
                label="Verify token"
                configured={data.verifyTokenConfigured}
                hint={
                  data.verifyTokenConfigured
                    ? `Set (${data.verifyTokenMasked}). Paste the same value into Meta.`
                    : "Set WHATSAPP_WEBHOOK_VERIFY_TOKEN, then paste the same value into Meta."
                }
              />
              <StatusRow
                label="App secret"
                configured={data.appSecretConfigured}
                hint={
                  data.appSecretConfigured
                    ? "Set. Inbound webhook signatures are verified."
                    : "Set WHATSAPP_APP_SECRET (or META_APP_SECRET) to verify signatures."
                }
              />
            </div>

            <Separator />

            <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1.</span> In the Meta app dashboard, open{" "}
                <span className="font-medium text-foreground">WhatsApp → Configuration → Webhook</span> and
                click Edit.
              </li>
              <li>
                <span className="font-medium text-foreground">2.</span> Paste the callback URL above and the
                verify token, then Verify and save.
              </li>
              <li>
                <span className="font-medium text-foreground">3.</span> Subscribe the WABA to the{" "}
                <span className="font-mono text-xs">messages</span> field using the button below.
              </li>
            </ol>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground text-pretty">
                {ready
                  ? "Server environment looks ready for inbound delivery."
                  : "Configure the environment variables above for inbound delivery."}
              </span>
              <Button onClick={subscribe} disabled={subscribing}>
                {subscribing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Subscribe to messages
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function CopyRow({
  label,
  value,
  copyable = true,
}: {
  label: string
  value: string
  copyable?: boolean
}) {
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Could not copy to clipboard")
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">
          {value}
        </code>
        {copyable ? (
          <Button variant="outline" size="icon" onClick={copy} aria-label={`Copy ${label}`}>
            {copied ? <Check className="size-4 text-[#128C4A]" /> : <Copy className="size-4" />}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function StatusRow({
  label,
  configured,
  hint,
}: {
  label: string
  configured: boolean
  hint: string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {configured ? (
          <Badge variant="outline" className="gap-1 border-[#25D366]/40 text-[#128C4A]">
            <ShieldCheck className="size-3" /> Configured
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <ShieldAlert className="size-3" /> Missing
          </Badge>
        )}
      </div>
      <span className="text-xs text-muted-foreground text-pretty">{hint}</span>
    </div>
  )
}
