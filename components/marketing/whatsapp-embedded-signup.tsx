"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2, MessageCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { resolveEmbeddedSignupOrigin } from "@/lib/whatsapp-oauth"

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

/**
 * Graph version used to initialise the SDK; matches the server default.
 *
 * The Meta JS SDK derives the OAuth dialog version from FB.init's `version`,
 * so this MUST be current — an old value makes the popup open
 * `facebook.com/<old>/dialog/oauth`, which routes to the generic new-number
 * onboarding instead of the WhatsApp Business App coexistence flow.
 */
const SDK_GRAPH_VERSION = "v26.0"
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

  // Meta emits an ERROR/CANCEL session-info message when onboarding can't
  // proceed (e.g. the "can't onboard customers at the moment" barrier). The
  // FB.login callback never fires in that case, so we track it here to release
  // the button and surface a clear message instead of an endless spinner.
  const terminated = React.useRef(false)

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
        data?: {
          waba_id?: string
          phone_number_id?: string
          current_step?: string
          error_message?: string
        }
      }
      try {
        payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      if (payload?.type !== "WA_EMBEDDED_SIGNUP") return

      // Coexistence onboarding completes with
      // `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; the plain `FINISH` /
      // `FINISH_ONLY_WABA` variants are emitted by the other ES flows. Treat
      // them all as success and stash the ids for the code exchange.
      if (
        payload.event === "FINISH" ||
        payload.event === "FINISH_ONLY_WABA" ||
        payload.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
      ) {
        sessionInfo.current = {
          wabaId: payload.data?.waba_id,
          phoneNumberId: payload.data?.phone_number_id,
        }
        return
      }

      if (payload.event === "CANCEL") {
        // User backed out, or Meta stopped the flow at a given step.
        terminated.current = true
        setSubmitting(false)
        const step = payload.data?.current_step
        toast.message(
          step
            ? `WhatsApp onboarding stopped at "${step}" before finishing.`
            : "WhatsApp onboarding was cancelled.",
        )
        return
      }

      if (payload.event === "ERROR") {
        terminated.current = true
        setSubmitting(false)
        toast.error(
          payload.data?.error_message ||
            "Meta couldn't complete WhatsApp onboarding. This usually means the Meta app isn't approved for customer onboarding yet (business verification / Advanced Access / Live mode).",
        )
        return
      }

      // Any other WA_EMBEDDED_SIGNUP payload that still carries ids.
      if (payload.data?.waba_id || payload.data?.phone_number_id) {
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

    // Sanitized diagnostic — the JS SDK controls the OAuth redirect_uri, which
    // Meta validates against the page origin. `redirectUri` here is the exact
    // origin the SDK will present; it is the value that must be whitelisted in
    // the Meta dashboard. Never log tokens, secrets, or the auth code.
    const origin = resolveEmbeddedSignupOrigin()

    // The coexistence launch selector. The WhatsApp Business App onboarding
    // branch is triggered strictly by `featureType`; `setup` must be present
    // (even empty) and `sessionInfoVersion` is vestigial for v4 but harmless.
    // This is the exact object handed to FB.login below — we log it verbatim so
    // the browser console proves what Meta actually receives at runtime.
    const extras = {
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
    } as const

    // Sanitized diagnostic — never logs tokens, secrets or the auth code. The
    // `configId` / `featureType` printed here are the values Meta receives; if
    // configId is not 1416471993755763 the production env var is wrong, and if
    // Meta still shows the new-number screen with featureType present, the
    // remaining issue is Meta-side config/eligibility, not this code.
    console.log("[WhatsApp ES] launch config", {
      appId: APP_ID,
      configId: CONFIG_ID,
      graphVersion: SDK_GRAPH_VERSION,
      origin,
      redirectUri: origin,
      extras,
    })

    sessionInfo.current = {}
    terminated.current = false
    window.FB.login(
      (response) => {
        const code = response?.authResponse?.code
        if (code) {
          void complete(code)
        } else if (!terminated.current) {
          // The FB.login callback fired without a code and no ERROR/CANCEL
          // session-info message arrived — the popup was closed, or Meta showed
          // the generic "Add your WhatsApp phone number / create a new one"
          // screen instead of the coexistence QR step. The latter means the
          // Embedded Signup configuration did not launch with the coexistence
          // feature type.
          console.warn(
            "[v0] Embedded Signup returned no code. If Meta showed the generic new-number screen, the coexistence flow did not launch.",
            {
              configId: CONFIG_ID,
              featureType: "whatsapp_business_app_onboarding",
              sdkVersion: SDK_GRAPH_VERSION,
            },
          )
          toast.message(
            "WhatsApp onboarding didn't complete. If Meta asked you to create a NEW number instead of scanning a QR code, the WhatsApp Business App coexistence flow wasn't launched — check the Embedded Signup Config ID and that its feature type is “WhatsApp Business App onboarding”.",
          )
        }
      },
      {
        config_id: CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        // Coexistence onboarding: keep the existing WhatsApp Business App number
        // and complete the QR scan instead of registering a new one. Same object
        // that was logged above, so the diagnostic can't drift from what is sent.
        extras,
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
