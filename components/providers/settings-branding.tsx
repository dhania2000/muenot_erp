"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"
import { useSettings } from "@/components/providers/settings-provider"

const LANG_CODES: Record<string, string> = {
  English: "en",
  Hindi: "hi",
  Spanish: "es",
  French: "fr",
  German: "de",
  Arabic: "ar",
}

/**
 * Applies theme + branding settings to the live document:
 * - injects theme.primary_color / theme.sidebar_color as CSS variables
 * - applies the default theme mode (Light / Dark / System)
 * - sets <html lang/dir> from language settings
 * - sets the document title and favicon from company/app settings
 *
 * Rendered inside SettingsProvider so it re-runs whenever settings change.
 */
export function SettingsBranding() {
  const settings = useSettings()
  const { setTheme } = useTheme()

  const primary = settings["theme.primary_color"]
  const sidebar = settings["theme.sidebar_color"]
  const mode = settings["theme.mode"]
  const appName = settings["app.name"] || settings["company.name"]
  const favicon = settings["company.favicon"]
  const language = settings["language.default"]
  const rtl = settings["language.rtl"]

  // Theme colours -> CSS variables (hex overrides the default oklch tokens).
  useEffect(() => {
    const el = document.documentElement
    if (primary) {
      el.style.setProperty("--primary", primary)
      el.style.setProperty("--sidebar-primary", primary)
      el.style.setProperty("--ring", primary)
    }
    if (sidebar) {
      el.style.setProperty("--sidebar", sidebar)
    }
  }, [primary, sidebar])

  // Default theme mode. Applied only as the initial default — a theme the user
  // picked themselves (persisted by next-themes under the "theme" key) always
  // wins, so the Light/Dark toggle in the profile menu sticks across reloads
  // and navigation instead of being overridden by the org default.
  useEffect(() => {
    if (!mode) return
    try {
      if (localStorage.getItem("theme")) return
    } catch {
      // localStorage unavailable (SSR/privacy mode) — fall through to default.
    }
    setTheme(mode.toLowerCase() === "system" ? "system" : mode.toLowerCase())
  }, [mode, setTheme])

  // Language + direction.
  useEffect(() => {
    const el = document.documentElement
    if (language && LANG_CODES[language]) el.setAttribute("lang", LANG_CODES[language])
    const isRtl = (rtl || "").toLowerCase() === "enabled" || language === "Arabic"
    el.setAttribute("dir", isRtl ? "rtl" : "ltr")
  }, [language, rtl])

  // Document title + favicon.
  useEffect(() => {
    if (appName) document.title = appName
    if (favicon) {
      let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
      if (!link) {
        link = document.createElement("link")
        link.rel = "icon"
        document.head.appendChild(link)
      }
      link.href = favicon
    }
  }, [appName, favicon])

  return null
}
