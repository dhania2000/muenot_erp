"use client"

import * as React from "react"
import { toast } from "sonner"
import { MessageCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Meta Embedded Signup launcher shared by tenant and platform workspaces. */
type StartResult = {
  state?: string
  appId: string | null
  configId: string | null
  graphVersion: string
  ready: boolean
  missing?: string[]
}

declare global {
  interface Window {
    FB?: {
      init: (params: Record<string, unknown>) => void
      login: (cb: (res: FbLoginResponse) => void, opts: Record<string, unknown>) => void
    }
    fbAsyncInit?: () => void
  }
}

type FbLoginResponse = {
  authResponse?: { code?: string } | null
  status?: string
}

const SDK_ID = "facebook-jssdk"
const SDK_TIMEOUT_MS = 15000
let sdkPromise: Promise<NonNullable<Window["FB"]>> | null = null

function loadFacebookSdk(appId: string, graphVersion: string): Promise<NonNullable<Window["FB"]>> {
  const init = () => {
    window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion })
    return window.FB!
  }
  if (window.FB) return Promise.resolve(init())

  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const fail = (message: string) => {
        sdkPromise = null
        reject(new Error(message))
      }
      const timer = setTimeout(
        () => fail("The Meta SDK could not be loaded. An ad blocker, extension or network policy may be blocking connect.facebook.net."),
        SDK_TIMEOUT_MS,
      )
      window.fbAsyncInit = () => {
        clearTimeout(timer)
        resolve(init())
      }

      const existing = document.getElementById(SDK_ID) as HTMLScriptElement | null
      if (existing) {
        existing.addEventListener("load", () => window.fbAsyncInit?.(), { once: true })
        existing.addEventListener("error", () => {
          clearTimeout(timer)
          existing.remove()
          fail("Could not load the Meta SDK. Check your network and try again.")
        }, { once: true })
        return
      }

      const script = document.createElement("script")
      script.id = SDK_ID
      script.src = "https://connect.facebook.net/en_US/sdk.js"
      script.async = true
      script.defer = true
      script.crossOrigin = "anonymous"
      script.onerror = () => {
        clearTimeout(timer)
        script.remove()
        fail("Could not load the Meta SDK. Check your network and try again.")
      }
      document.body.appendChild(script)
    })
  }
  return sdkPromise
}

export function EmbeddedSignupConnect({
  onConnected,
  variant = "default",
  className,
  startUrl = "/api/marketing/whatsapp/signup/start",
  readinessUrl = startUrl,
  startBody,
}: {
  onConnected: () => void
  variant?: React.ComponentProps<typeof Button>["variant"]
  className?: string
  startUrl?: string
  readinessUrl?: string
  startBody?: Record<string, unknown>
}) {
  const [busy, setBusy] = React.useState(false)
  const [missing, setMissing] = React.useState<string[] | null>(null)
  const sessionInfo = React.useRef<{ wabaId?: string; phoneNumberId?: string; businessId?: string }>({})

  React.useEffect(() => {
    let cancelled = false
    fetch(readinessUrl, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return
        setMissing(data?.ready ? [] : (data?.missing ?? []))
        if (data?.ready && data.appId) {
          loadFacebookSdk(data.appId, data.graphVersion ?? "v26.0").catch(() => undefined)
        }
      })
      .catch(() => {
        if (!cancelled) setMissing([])
      })
    return () => {
      cancelled = true
    }
  }, [readinessUrl])

  React.useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== "https://www.facebook.com" && event.origin !== "https://web.facebook.com") return
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return
        if (data.event === "FINISH" && data.data) {
          sessionInfo.current = {
            wabaId: data.data.waba_id,
            phoneNumberId: data.data.phone_number_id,
            businessId: data.data.business_id,
          }
        }
      } catch {
        /* Ignore unrelated non-JSON messages from Meta widgets. */
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  async function connect() {
    setBusy(true)
    sessionInfo.current = {}
    try {
      const startRes = await fetch(startUrl, {
        method: "POST",
        headers: startBody ? { "Content-Type": "application/json" } : undefined,
        body: startBody ? JSON.stringify(startBody) : undefined,
      })
      const start = (await startRes.json().catch(() => ({}))) as StartResult & { error?: string }
      if (!startRes.ok) throw new Error(start.error || "Could not start WhatsApp signup.")
      if (!start.ready || !start.appId || !start.configId || !start.state) {
        throw new Error(
          `Embedded Signup is not configured on the server yet. Set ${start.missing?.join(" and ") || "WHATSAPP_APP_ID and WHATSAPP_CONFIG_ID"}, or connect with credentials instead.`,
        )
      }

      const FB = await loadFacebookSdk(start.appId, start.graphVersion)
      const authResponse = await new Promise<FbLoginResponse>((resolve) => {
        FB.login((res) => resolve(res), {
          config_id: start.configId,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
        })
      })

      const code = authResponse?.authResponse?.code
      if (!code) return

      const { wabaId, phoneNumberId, businessId } = sessionInfo.current
      if (!wabaId || !phoneNumberId) {
        throw new Error("Meta did not return your WhatsApp number details. Please try the connection again.")
      }

      const cbRes = await fetch("/api/marketing/whatsapp/signup/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: start.state, code, wabaId, phoneNumberId, businessId }),
      })
      const cb = (await cbRes.json().catch(() => ({}))) as {
        error?: string
        autoConfig?: { webhookSubscribed: boolean; templatesSynced: number }
      }
      if (!cbRes.ok) throw new Error(cb.error || "Could not complete the WhatsApp connection.")

      const parts = ["WhatsApp Business connected"]
      if (cb.autoConfig?.webhookSubscribed) parts.push("webhook subscribed")
      if (cb.autoConfig?.templatesSynced) parts.push(`${cb.autoConfig.templatesSynced} templates synced`)
      toast.success(parts.join(" · "))
      onConnected()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unconfigured = (missing?.length ?? 0) > 0
  return (
    <Button
      variant={variant}
      className={className}
      onClick={connect}
      disabled={busy || unconfigured}
      title={
        unconfigured
          ? `Embedded Signup is not configured on the server. Set ${missing?.join(" and ")}, then restart. You can connect with credentials instead.`
          : undefined
      }
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
      Connect with Meta
    </Button>
  )
}
