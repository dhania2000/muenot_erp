"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import type { SettingsMap } from "@/lib/settings/format"

const STORAGE_KEY = "muenot.cookie-consent"
const fetcher = (url: string) => fetch(url).then((r) => r.json())

function enabled(v: string | undefined) {
  if (!v) return false
  const t = v.trim().toLowerCase()
  return t === "enabled" || t === "true" || t === "1" || t === "yes"
}

/**
 * GDPR cookie-consent banner driven by Company Settings:
 * shown only when GDPR is enabled AND the cookie-consent toggle is on. The
 * consent choice is stored in localStorage (consent state, not app data) so the
 * banner does not reappear once acknowledged.
 */
export function CookieConsent() {
  const { data } = useSWR<{ values: SettingsMap }>("/api/settings/public", fetcher, {
    revalidateOnFocus: false,
  })
  const settings = data?.values ?? {}
  const [acknowledged, setAcknowledged] = useState(true)

  useEffect(() => {
    try {
      setAcknowledged(localStorage.getItem(STORAGE_KEY) != null)
    } catch {
      setAcknowledged(false)
    }
  }, [])

  const shouldShow = enabled(settings["gdpr.enabled"]) && enabled(settings["gdpr.cookie_consent"])
  if (!shouldShow || acknowledged) return null

  const text =
    settings["gdpr.consent_text"] ||
    "We use cookies to keep you signed in and to improve your experience. By continuing, you agree to our use of cookies."

  function decide(value: "accepted" | "declined") {
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      /* ignore storage failures */
    }
    setAcknowledged(true)
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4" role="dialog" aria-label="Cookie consent">
      <div className="flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl sm:flex-row sm:items-center sm:justify-between">
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{text}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => decide("declined")}>
            Decline
          </Button>
          <Button size="sm" onClick={() => decide("accepted")}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  )
}
