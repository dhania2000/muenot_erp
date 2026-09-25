"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

// SPECS 67–74 — shared sub-navigation for the Data Governance admin area.
// Mirrors the SecurityTabs pattern so the whole cluster shares one look.
const TABS: { label: string; href: string }[] = [
  { label: "Audit log", href: "/admin/governance" },
  { label: "Master data", href: "/admin/governance/master-data" },
  { label: "Classification", href: "/admin/governance/classification" },
  { label: "Field security", href: "/admin/governance/field-security" },
  { label: "Retention", href: "/admin/governance/retention" },
  { label: "Legal holds", href: "/admin/governance/legal-holds" },
  { label: "Privacy", href: "/admin/governance/privacy" },
  { label: "Import center", href: "/admin/governance/import-center" },
  { label: "Export center", href: "/admin/governance/export-center" },
]

export function GovernanceTabs() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-wrap gap-1 border-b" aria-label="Data governance sections">
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
