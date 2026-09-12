"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

/** Native select styled to match the shadcn input — avoids base-ui verbosity. */
export function NativeSelect({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

/** Centered empty / permission / loading state used across the tabs. */
export function TabState({
  loading,
  children,
}: {
  loading?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-muted-foreground">
      {loading ? <Loader2 className="size-5 animate-spin" /> : null}
      {children}
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  ok: "bg-[#25D366]",
  warn: "bg-amber-500",
  error: "bg-destructive",
  unknown: "bg-muted-foreground",
}

/** Small coloured dot for a diagnostic check status. */
export function StatusDot({ status }: { status: string }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", STATUS_STYLES[status] ?? STATUS_STYLES.unknown)} />
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}
