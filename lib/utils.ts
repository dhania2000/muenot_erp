import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(
  value: number | string | null | undefined,
  currency = "USD",
): string {
  const num = typeof value === "string" ? Number.parseFloat(value) : value
  if (num == null || Number.isNaN(num)) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(num)
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return "—"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date)
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return "—"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

/**
 * Normalizes a date value to a `yyyy-MM-dd` string suitable for a native
 * `<input type="date">` value. Returns an empty string for missing/invalid input.
 */
export function toDateInputValue(value: string | number | Date | null | undefined): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * When pasting into a plain-text email body textarea, strip HTML markup so the
 * user gets readable text instead of raw source. Falls back to the default
 * paste behavior when the clipboard has no HTML.
 */
export function handleHtmlSourcePaste(
  event: React.ClipboardEvent<HTMLTextAreaElement>,
  currentValue: string,
  onChange: (next: string) => void,
): void {
  const html = event.clipboardData.getData("text/html")
  if (!html) return

  event.preventDefault()

  let text = html
  if (typeof window !== "undefined" && typeof window.DOMParser !== "undefined") {
    const doc = new window.DOMParser().parseFromString(html, "text/html")
    text = doc.body.textContent ?? ""
  } else {
    text = html.replace(/<[^>]*>/g, "")
  }
  text = text.replace(/\u00a0/g, " ").trim()

  const target = event.currentTarget
  const start = target.selectionStart ?? currentValue.length
  const end = target.selectionEnd ?? currentValue.length
  const next = currentValue.slice(0, start) + text + currentValue.slice(end)
  onChange(next)
}
