import { CheckCircle2, Clock, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

// SPECS 56–66 — a single, honest status banner used across the Security &
// Access screens. It tells the admin exactly what the platform can enforce
// today so no screen implies a capability the backend does not have.
//
//   live    → the backend enforces this now (e.g. TOTP MFA enrollment).
//   partial → part of the capability is enforced; the rest is UI-only.
//   planned → the screen shows the intended structure but the backend cannot
//             enforce it yet. Nothing is faked and no data is stored.
export type BackendLevel = "live" | "partial" | "planned"

const CONFIG: Record<
  BackendLevel,
  { label: string; icon: typeof CheckCircle2; wrap: string; badge: string }
> = {
  live: {
    label: "Enforced by backend",
    icon: CheckCircle2,
    wrap: "border-emerald-500/30 bg-emerald-500/5 text-emerald-900 dark:text-emerald-200",
    badge: "border-transparent bg-emerald-600 text-white",
  },
  partial: {
    label: "Partially enforced",
    icon: Info,
    wrap: "border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-200",
    badge: "border-transparent bg-amber-600 text-white",
  },
  planned: {
    label: "Backend not yet available",
    icon: Clock,
    wrap: "border-muted-foreground/20 bg-muted/40 text-foreground",
    badge: "border-transparent bg-muted-foreground/80 text-background",
  },
}

export function BackendStatus({
  level,
  children,
}: {
  level: BackendLevel
  children: React.ReactNode
}) {
  const cfg = CONFIG[level]
  const Icon = cfg.icon
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-4 text-sm", cfg.wrap)} role="note">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <Badge className={cn("font-medium", cfg.badge)}>{cfg.label}</Badge>
        <p className="leading-relaxed">{children}</p>
      </div>
    </div>
  )
}
