"use client"

import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ConnectionHealth } from "./types"

const MAP = {
  healthy: { label: "Connected", icon: CheckCircle2, className: "border-transparent bg-[#25D366] text-white" },
  degraded: { label: "Degraded", icon: AlertTriangle, className: "border-transparent bg-amber-500 text-white" },
  down: { label: "Disconnected", icon: XCircle, className: "border-transparent bg-destructive text-white" },
  disconnected: { label: "Not connected", icon: HelpCircle, className: "border-transparent bg-muted-foreground text-white" },
} as const

/** Real-time connection pill derived from the live health probe. */
export function WhatsAppConnectionBadge({ health }: { health: ConnectionHealth }) {
  const state = MAP[health.overall] ?? MAP.disconnected
  const Icon = state.icon
  return (
    <Badge className={cn("gap-1.5 px-3 py-1 text-xs", state.className)}>
      <Icon className="size-3.5" />
      {state.label}
    </Badge>
  )
}
