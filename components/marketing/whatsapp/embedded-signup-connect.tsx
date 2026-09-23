"use client"

import * as React from "react"
import { toast } from "sonner"
import { MessageCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { launchFacebookSignup, requireSignupConfig, signupDetails, type FacebookLoginResponse as FbLoginResponse, type SignupConfig as StartResult } from "@/lib/whatsapp-signup-client"

/** Meta Embedded Signup launcher shared by tenant and platform workspaces. */

declare global {
  interface Window {
    FB?: {
      init: (params: Record<string, unknown>) => void
      login: (cb: (res: FbLoginResponse) => void, opts: Record<string, unknown>) => void
    }
    fbAsyncInit?: () => void
  }
}


const SDK_ID = "facebook-jssdk"
const SDK_TIMEOUT_MS = 15000
let sdkPromise: Promise<NonNullable<Window["FB"]>> | null = null

function loadFacebookSdk(appId: string, graphVersion: string): Promise<NonNullable<Window["FB"]>> {
  const init = () => {
    window.FB!.init({ appId, autoLogAppEvents: false, xfbml: false, version: graphVersion })
    return window.FB!
  }
  if (window.FB) return Promise.resolve(init())

  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer)
        document.getElementById(SDK_ID)?.remove()
        window.fbAsyncInit = undefined
        sdkPromise = null
        reject(new Error(message))
      }
      const timer = setTimeout(
        () => fail("The Meta SDK could not be loaded. An ad blocker, extension or network policy may be blocking connect.facebook.net."),
        SDK_TIMEOUT_MS,
      )
      window.fbAsyncInit = () => {
        clearTimeout(timer)
        try { resolve(init()) } catch { fail("Meta SDK initialization failed. Check the App ID and retry.") }
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
  callbackUrl = "/api/marketing/whatsapp/signup/callback",
  callbackBody,
  onFailed,
}: {
  onConnected: () => void
  variant?: React.ComponentProps<typeof Button>["variant"]
  className?: string
  startUrl?: string
  readinessUrl?: string
  startBody?: Record<string, unknown>
  callbackUrl?: string
  callbackBody?: Record<string, unknown>
  onFailed?: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [hint, setHint] = React.useState("Preparing Facebook login…")
  const prepared = React.useRef<{ config: StartResult; sdk: NonNullable<Window["FB"]>; url: string } | null>(null)
  const preparing = React.useRef<Promise<void> | null>(null)
  const active = React.useRef(false)
  const sessionInfo = React.useRef<{ wabaId?: string; phoneNumberId?: string; businessId?: string }>({})

  const prepare = React.useCallback(() => {
    if (preparing.current) return preparing.current
    setHint("Preparing Facebook login…")
    prepared.current = null
    const task = (async () => {
      const res = await fetch(readinessUrl, { cache: "no-store", signal: AbortSignal.timeout(15000) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not check Meta settings. Retry.")
      requireSignupConfig(data)
      const config = { ...data, graphVersion: data.graphVersion ?? "v26.0" } as StartResult
      const sdk = await loadFacebookSdk(config.appId!, config.graphVersion)
      prepared.current = { config, sdk, url: readinessUrl }
      setHint("")
    })()
    preparing.current = task
    void task.catch(error => setHint(error instanceof Error ? error.message : "Could not prepare Meta login. Retry.")).finally(() => { preparing.current = null })
    return task
  }, [readinessUrl])

  React.useEffect(() => { void prepare().catch(() => undefined) }, [prepare])

  React.useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!active.current) return
      const details = signupDetails(event)
      if (details) sessionInfo.current = details
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  async function connect() {
    if (active.current) return
    const ready = prepared.current
    if (!ready || ready.url !== readinessUrl) {
      setBusy(true)
      try {
        await prepare()
        setHint("Ready. Click Connect with Meta to open Facebook login.")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Meta login could not be prepared.")
      } finally { setBusy(false) }
      return
    }
    active.current = true
    setBusy(true)
    setHint("")
    sessionInfo.current = {}
    try {
      // Invoke synchronously in this click, before ANY network await. The
      // signed tenant-bound session is still required before callback exchange.
      const login = launchFacebookSignup(ready.sdk, ready.config)
      const starting = fetch(startUrl, {
        method: "POST",
        headers: startBody ? { "Content-Type": "application/json" } : undefined,
        body: startBody ? JSON.stringify(startBody) : undefined,
        signal: AbortSignal.timeout(20000),
      }).then(async startRes => {
        const start = (await startRes.json().catch(() => ({}))) as StartResult & { error?: string }
        if (!startRes.ok) throw new Error(start.error || "Could not start WhatsApp signup.")
        requireSignupConfig(start)
        if (!start.state) throw new Error("Missing secure signup session. Please retry.")
        if (start.appId !== ready.config.appId || start.configId !== ready.config.configId) {
          prepared.current = null
          throw new Error("Meta settings changed. Close the Facebook window and retry.")
        }
        return start
      })
      const [start, authResponse] = await Promise.all([starting, login])

      const code = authResponse?.authResponse?.code
      if (!code) { setHint("Facebook login was cancelled or not authorized. You can retry."); onFailed?.(); return }

      // Meta's FINISH message and login callback can arrive in either order.
      for (let i = 0; i < 50 && (!sessionInfo.current.wabaId || !sessionInfo.current.phoneNumberId); i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const { wabaId, phoneNumberId, businessId } = sessionInfo.current
      if (!wabaId || !phoneNumberId) {
        throw new Error("Meta did not return your WhatsApp number details. Please try the connection again.")
      }

      const cbRes = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...callbackBody, state: start.state, code, wabaId, phoneNumberId, businessId }),
        signal: AbortSignal.timeout(60000),
      })
      const cb = (await cbRes.json().catch(() => ({}))) as {
        registration?: { cloudApiRegistered: boolean; errorMessage?: string | null }
        error?: string
        autoConfig?: { webhookSubscribed: boolean; templatesSynced: number }
      }
      if (!cbRes.ok) throw new Error(cb.error || "Could not complete the WhatsApp connection.")

      const parts = [cb.registration?.cloudApiRegistered ? "Cloud API registered / Messaging ready" : "Connected to Meta · registration needs verification"]
      if (cb.autoConfig?.webhookSubscribed) parts.push("webhook subscribed")
      if (cb.autoConfig?.templatesSynced) parts.push(`${cb.autoConfig.templatesSynced} templates synced`)
      toast.success(parts.join(" · "))
      if (cb.registration?.errorMessage) toast.warning(cb.registration.errorMessage)
      onConnected()
    } catch (err) {
      setHint((err as Error).message)
      toast.error((err as Error).message)
      onFailed?.()
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex max-w-xl flex-col items-start gap-2">
    <Button
      variant={variant}
      className={className}
      onClick={connect}
      disabled={busy}
      type="button"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
      Connect with Meta
    </Button>
    {hint && <span role="status" className="text-sm text-muted-foreground">{hint}</span>}
    </span>
  )
}
