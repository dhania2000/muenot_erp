import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

type DateInput = string | number | Date | null | undefined

function toDate(value: DateInput): Date | null {
  if (value == null || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Format a date as e.g. "30 Aug 2026". Returns "—" for empty/invalid input. */
export function formatDate(value: DateInput): string {
  const d = toDate(value)
  if (!d) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Format a date + time as e.g. "30 Aug 2026, 14:05". Returns "—" for empty/invalid input. */
export function formatDateTime(value: DateInput): string {
  const d = toDate(value)
  if (!d) return '—'
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Format a number as INR currency, e.g. "₹1,25,000". Returns "—" for empty input. */
export function formatCurrency(value: number | string | null | undefined, currency = 'INR'): string {
  if (value == null || value === '') return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n)
}

/** Convert a date value to a "YYYY-MM-DD" string suitable for <input type="date">. */
export function toDateInputValue(value: DateInput): string {
  const d = toDate(value)
  if (!d) return ''
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
