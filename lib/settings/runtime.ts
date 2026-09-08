/**
 * Client-safe runtime settings cache. Mirrors the pattern used by
 * finance-calc's configureCurrency(): the SettingsProvider pushes the merged
 * company settings here once on load, so the shared pure formatters in
 * lib/utils and lib/recruit can honour the configured date / time / timezone
 * format without every call site needing access to React context.
 *
 * Falls back to an empty map, in which case the underlying formatters use their
 * documented defaults (DD-MM-YYYY, 12 Hours, local timezone).
 */
import {
  formatDate,
  formatDateTime,
  formatTime,
  type SettingsMap,
} from "@/lib/settings/format"

let runtimeSettings: SettingsMap = {}

export function configureRuntimeSettings(settings: SettingsMap) {
  runtimeSettings = settings || {}
}

export function getRuntimeSettings(): SettingsMap {
  return runtimeSettings
}

export function rtFormatDate(value: Date | string | number | null | undefined): string {
  return formatDate(value, runtimeSettings)
}

export function rtFormatTime(value: Date | string | number | null | undefined): string {
  return formatTime(value, runtimeSettings)
}

export function rtFormatDateTime(value: Date | string | number | null | undefined): string {
  return formatDateTime(value, runtimeSettings)
}
