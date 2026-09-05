import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value as string | number)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(value: unknown): string {
  const date = toDate(value)
  if (!date) return "—"
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function formatDateTime(value: unknown): string {
  const date = toDate(value)
  if (!date) return "—"
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function formatCurrency(value: unknown, currency = "INR"): string {
  const amount = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(amount)) return "—"
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount)
}

/**
 * Extracts clean HTML source from clipboard `text/html` data. Browsers wrap
 * copied rich content in <html>/<head>/<body> shells plus Office-style
 * StartFragment/EndFragment comment markers; we strip those so the raw markup
 * that gets pasted into an HTML body/signature field is the meaningful part.
 */
export function cleanPastedHtml(html: string): string {
  let out = html
  const start = out.indexOf("<!--StartFragment-->")
  const end = out.indexOf("<!--EndFragment-->")
  if (start !== -1 && end !== -1 && end > start) {
    out = out.slice(start + "<!--StartFragment-->".length, end)
  }
  out = out
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[^>]*>/gi, "")
    .replace(/<meta[^>]*>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, "")
    .replace(/<title[\s\S]*?<\/title>/gi, "")
  return out.trim()
}

/**
 * Paste handler for plain <textarea> fields that hold HTML source. When the
 * clipboard carries rendered HTML (e.g. a formatted signature), inserts the
 * actual markup at the cursor instead of letting the browser drop everything
 * to plain text. Falls back to the default paste when no HTML flavor exists.
 */
export function handleHtmlSourcePaste(
  e: React.ClipboardEvent<HTMLTextAreaElement>,
  currentValue: string,
  onChange: (next: string) => void,
): void {
  const html = e.clipboardData.getData("text/html")
  if (!html) return
  e.preventDefault()
  const snippet = cleanPastedHtml(html)
  if (!snippet) return
  const el = e.currentTarget
  const start = el.selectionStart ?? currentValue.length
  const end = el.selectionEnd ?? currentValue.length
  const next = currentValue.slice(0, start) + snippet + currentValue.slice(end)
  onChange(next)
  requestAnimationFrame(() => {
    const pos = start + snippet.length
    el.selectionStart = el.selectionEnd = pos
    el.focus()
  })
}

export function toDateInputValue(value: unknown): string {
  const date = toDate(value)
  if (!date) return ""
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10)
}
