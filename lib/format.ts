export function formatCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(Number(n))) return "—"
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(n))
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(Number(n))) return "—"
  return new Intl.NumberFormat("en-US").format(Number(n))
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—"
  const date = typeof d === "string" ? new Date(d) : d
  if (isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?"
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
}

// Tone mapping for pipeline/deal statuses -> badge variant.
export function statusTone(status: string | null | undefined): "default" | "success" | "warning" | "destructive" | "muted" {
  const s = (status || "").toLowerCase()
  if (["won", "accepted", "active", "completed", "signed"].some((k) => s.includes(k))) return "success"
  if (["lost", "rejected", "expired", "cancelled", "overdue", "bounced"].some((k) => s.includes(k))) return "destructive"
  if (["proposal", "in discussion", "negotiation", "in progress", "sent", "follow up", "follow-up"].some((k) => s.includes(k)))
    return "warning"
  if (["new", "draft", "open"].some((k) => s.includes(k))) return "default"
  return "muted"
}
