"use client"
import { useEffect, useState } from "react"
import { EmbeddedSignupConnect } from "@/components/marketing/whatsapp/embedded-signup-connect"

export function MobileWhatsAppConnect() {
  const [token, setToken] = useState("")
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("session") || ""
    setToken(value)
    if (value) window.history.replaceState(null, "", window.location.pathname)
  }, [])
  const returnToApp = (result: "connected" | "error") => { window.location.href = `muenot://whatsapp/${result}` }
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-6">
    <h1 className="text-2xl font-semibold">Connect WhatsApp to Muenot</h1>
    <p className="text-muted-foreground">Continue with Meta to connect your business number. Your credentials stay securely on Muenot servers.</p>
    {token ? <EmbeddedSignupConnect readinessUrl="/api/mobile/v1/whatsapp/onboarding-config"
      startUrl="/api/mobile/v1/whatsapp/onboarding-launch" startBody={{ launchToken: token }}
      callbackUrl="/api/mobile/v1/whatsapp/onboarding-callback" callbackBody={{ launchToken: token }}
      onConnected={() => returnToApp("connected")} onFailed={() => returnToApp("error")} />
      : <p role="alert">This onboarding link is invalid. Return to the app and try again.</p>}
    <button type="button" className="text-left text-sm underline" onClick={() => returnToApp("error")}>Return to Muenot app</button>
  </main>
}
