"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

// SPECS 56–66 — shared sub-navigation for the Security & Access admin area.
// Mirrors the AutomationTabs pattern so the whole cluster shares one look.
const TABS: { label: string; href: string }[] = [
  { label: "Overview", href: "/admin/security" },
  { label: "SSO", href: "/admin/security/sso" },
  { label: "MFA", href: "/admin/security/mfa" },
  { label: "Passwords", href: "/admin/security/password" },
  { label: "Sessions", href: "/admin/security/sessions" },
  { label: "API & webhooks", href: "/admin/security/api-webhooks" },
  { label: "IP allowlist", href: "/admin/security/ip-allowlist" },
  { label: "Access policies", href: "/admin/security/access-policies" },
  { label: "Temporary access", href: "/admin/security/temporary-access" },
  { label: "Emergency access", href: "/admin/security/emergency-access" },
  { label: "Access reviews", href: "/admin/security/access-reviews" },
  { label: "Alerts", href: "/admin/security/alerts" },
  { label: "Risk queue", href: "/admin/security/anomalies" },
  { label: "Audit log", href: "/admin/security/audit-log" },
  { label: "Audit retention", href: "/admin/security/audit-retention" },
]

export function SecurityTabs() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-wrap gap-1 border-b" aria-label="Security sections">
      {TABS.map((tab) => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
