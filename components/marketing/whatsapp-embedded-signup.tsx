"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2, MessageCircle } from "lucide-react"

import { Button } from "@/components/ui/button"

/* ------------------------------------------------------------------ */
/* Meta JS SDK types (only what we use)                                */
/* ------------------------------------------------------------------ */

type FBLoginResponse = {
  authResponse?: { code?: string } | null
  status?: string
}

type FB = {
  init: (params: {
    appId: string
    autoLogAppEvents?: boolean
    xfbml?: boolean
    version: string
  }) => void
  login: (
    callback: (response: FBLoginResponse) => void,
    options: {
      config_id: string
      response_type: "code"
      override_default_response_type: boolean
      extras: {
        setup: Record<string, unknown>
        featureType: string
        sessionInfoVersion: string
      }
    },
  ) => void
}

declare global {
  interface Window {
    FB?: FB
    fbAsyncInit?: () => void
  }
}

/** Graph version used to initialise the SDK; matches the server default. */
const SDK_GRAPH_VERSION = "v23.0"
const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js"

const APP_ID = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID
const CONFIG_ID = process.env.NEXT_PUBLIC_WHATSAPP_ES_CONFIG_ID

/** Loads + initialises the Meta JS SDK exactly once across the app. */
function useFacebookSdk(appId: string | undefined) {
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    if (!appId) return
    if (window.FB) {
      setReady(true)
      return
    }

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: SDK_GRAPH_VERSION,
      })
      setReady(true)
    }

    if (!document.getElementById("facebook-jssdk")) {
      const script = document.createElement("script")
      script.id = "facebook-jssdk"
      script.src = SDK_SRC
      script.async = true
      script.defer = true
      script.crossOrigin = "anonymous"
      document.body.appendChild(script)
    }
  }, [appId])

  return ready
}

/* ------------------------------------------------------------------ */
/* Embedded Signup button                                              */
/* ------------------------------------------------------------------ */

export function WhatsAppEmbeddedSignup({
  onConnected,
  label = "Connect WhatsApp Business App",
  variant = "default",
  className,
}: {
  onConnected?: () => void
  label?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  className?: string
}) {
  const sdkReady = useFacebookSdk(APP_ID)
  const [submitting, setSubmitting] = React.useState(false)

  // The session-info message arrives separately from the FB.login callback, so
  // we stash the selected WABA + phone number id here until the code returns.
  const sessionInfo = React.useRef<{ wabaId?: string; phoneNumberId?: string }>({})

  React.useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (
        event.origin !== "https://www.facebook.com" &&
        event.origin !== "https://web.facebook.com"
      ) {
        return
      }
      let payload: {
        type?: string
        event?: string
        data?: { waba_id?: string; phone_number_id?: string }
      }
      try {
        payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      if (payload?.type === "WA_EMBEDDED_SIGNUP") {
        sessionInfo.current = {
          wabaId: payload.data?.waba_id,
          phoneNumberId: payload.data?.phone_number_id,
        }
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  async function complete(code: string) {
    setSubmitting(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/embedded-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          wabaId: sessionInfo.current.wabaId,
          phoneNumberId: sessionInfo.current.phoneNumberId,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to connect WhatsApp Business App")
      if (json.webhookSubscribed === false) {
        toast.warning(
          "Connected, but automatic webhook subscription failed. Use “Subscribe to messages” in Webhook setup.",
        )
      } else {
        toast.success("WhatsApp Business App connected")
      }
      sessionInfo.current = {}
      onConnected?.()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  function launch() {
    if (!APP_ID || !CONFIG_ID) {
      toast.error(
        "WhatsApp onboarding is not configured. Set NEXT_PUBLIC_WHATSAPP_APP_ID and NEXT_PUBLIC_WHATSAPP_ES_CONFIG_ID.",
      )
      return
    }
    if (!window.FB) {
      toast.error("The Meta SDK is still loading — try again in a moment.")
      return
    }
    sessionInfo.current = {}
    window.FB.login(
      (response) => {
        const code = response?.authResponse?.code
        if (code) {
          void complete(code)
        } else {
          // User closed the popup or denied — nothing to save.
          toast.message("WhatsApp onboarding was cancelled.")
        }
      },
      {
        config_id: CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          // Coexistence onboarding: keep the existing WhatsApp Business App
          // number and complete the QR scan instead of registering a new one.
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        },
      },
    )
  }

  const disabled = submitting || !sdkReady || !APP_ID || !CONFIG_ID

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant={variant} onClick={launch} disabled={disabled} className={className}>
        {submitting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <MessageCircle className="size-4" />
        )}
        {label}
      </Button>
      {!APP_ID || !CONFIG_ID ? (
        <p className="text-xs text-muted-foreground text-pretty">
          Set <span className="font-mono">NEXT_PUBLIC_WHATSAPP_APP_ID</span> and{" "}
          <span className="font-mono">NEXT_PUBLIC_WHATSAPP_ES_CONFIG_ID</span> to enable guided
          onboarding.
        </p>
      ) : null}
    </div>
  )
}
