"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

const TABS = [
  { label: "Overview", href: "/admin/automation" },
  { label: "Workflows", href: "/admin/workflows" },
  { label: "Events", href: "/admin/automation/events" },
  { label: "Notifications", href: "/admin/automation/notifications" },
  { label: "Email", href: "/admin/automation/email" },
]

export function AutomationTabs() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-wrap gap-1 border-b" aria-label="Automation center">
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
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
