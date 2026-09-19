"use client"

import * as React from "react"
import { toast } from "sonner"
import { MessageCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * "Connect with Meta" — the primary, self-service WhatsApp onboarding path.
 *
 * Launches Meta's Embedded Signup popup with the Facebook JS SDK. The popup
 * lets the tenant admin create/select their WhatsApp Business Account and phone
 * number entirely on Meta, then hands us:
 *   - an authorization `code` (via FB.login's authResponse), and
 *   - the WABA id + phone number id (via a postMessage "session info" event).
 *
 * We echo those, together with the server-minted CSRF `state`, back to
 * /signup/callback which resolves the tenant from the state, exchanges the code
 * for a token and connects + auto-configures the number. No secrets touch the
 * client: the app id / config id are fetched from /signup/start on demand.
 */

type StartResult = {
  state: string
  appId: string | null
  configId: string | null
  graphVersion: string
  ready: boolean
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

/** Loads the Facebook JS SDK once and resolves when window.FB is ready. */
function loadFacebookSdk(appId: string, graphVersion: string): Promise<NonNullable<Window["FB"]>> {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion })
      resolve(window.FB)
      return
    }
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion })
      resolve(window.FB!)
    }
    if (document.getElementById(SDK_ID)) return
    const script = document.createElement("script")
    script.id = SDK_ID
    script.src = "https://connect.facebook.net/en_US/sdk.js"
    script.async = true
    script.defer = true
    script.crossOrigin = "anonymous"
    script.onerror = () => reject(new Error("Could not load the Meta SDK. Check your network and try again."))
    document.body.appendChild(script)
  })
}

export function EmbeddedSignupConnect({
  onConnected,
  variant = "default",
  className,
  startUrl = "/api/marketing/whatsapp/signup/start",
  startBody,
}: {
  onConnected: () => void
  variant?: React.ComponentProps<typeof Button>["variant"]
  className?: string
  startUrl?: string
  startBody?: Record<string, unknown>
}) {
  const [busy, setBusy] = React.useState(false)
  // Captured from Meta's postMessage session-info event during the popup.
  const sessionInfo = React.useRef<{ wabaId?: string; phoneNumberId?: string; businessId?: string }>({})

  // Listen for the Embedded Signup "session info" message for the whole time the
  // component is mounted, so it is already captured when FB.login resolves.
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
        /* non-JSON messages from other Meta widgets — ignore */
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
      if (!start.ready || !start.appId || !start.configId) {
        throw new Error(
          "Embedded Signup is not configured on the server yet. Set WHATSAPP_APP_ID and WHATSAPP_CONFIG_ID, or connect with credentials instead.",
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
      if (!code) {
        // User closed the popup or denied — not an error worth a red toast.
        setBusy(false)
        return
      }

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

  return (
    <Button variant={variant} className={className} onClick={connect} disabled={busy}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
      Connect with Meta
    </Button>
  )
}
