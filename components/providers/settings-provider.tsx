"use client"

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"
import useSWR from "swr"
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  type SettingsMap,
} from "@/lib/settings/format"
import { configureCurrency, configureFinancialYear } from "@/lib/finance-calc"
import { configureRuntimeSettings } from "@/lib/settings/runtime"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const SettingsContext = createContext<SettingsMap>({})

/**
 * Fetches the public settings once and exposes them via context. Also pushes
 * currency + financial-year config into the shared finance-calc helpers so the
 * existing inr()/inr0() call sites reflect the configured currency live.
 */
export function SettingsProvider({
  children,
  initial,
}: {
  children: ReactNode
  initial?: SettingsMap
}) {
  const { data } = useSWR<{ values: SettingsMap }>("/api/settings/public", fetcher, {
    revalidateOnFocus: false,
    fallbackData: initial ? { values: initial } : undefined,
  })

  const settings = useMemo<SettingsMap>(
    () => ({ ...(initial || {}), ...(data?.values || {}) }),
    [initial, data],
  )

  useEffect(() => {
    configureCurrency(settings)
    configureFinancialYear(settings["app.financial_year_start"])
    configureRuntimeSettings(settings)
  }, [settings])

  return <SettingsContext.Provider value={settings}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsMap {
  return useContext(SettingsContext)
}

export function useSetting(key: string): string {
  return useContext(SettingsContext)[key] ?? ""
}

export function useModuleEnabled(name: string): boolean {
  const s = useContext(SettingsContext)
  const v = s[`module.${name.toLowerCase()}`]
  if (v == null) return true
  const t = v.trim().toLowerCase()
  return t === "enabled" || t === "true" || t === "1" || t === "yes"
}

export function useFormatCurrency() {
  const s = useSettings()
  return (value: number | string) => formatCurrency(value, s)
}

export function useFormatNumber() {
  const s = useSettings()
  return (value: number | string) => formatNumber(value, s)
}

export function useFormatDate() {
  const s = useSettings()
  return (value: Date | string | number | null | undefined) => formatDate(value, s)
}

export function useFormatTime() {
  const s = useSettings()
  return (value: Date | string | number | null | undefined) => formatTime(value, s)
}

export function useFormatDateTime() {
  const s = useSettings()
  return (value: Date | string | number | null | undefined) => formatDateTime(value, s)
}
