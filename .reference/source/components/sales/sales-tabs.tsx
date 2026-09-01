"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

export function SalesTabs({ tabs }: { tabs: { label: string; href: string }[] }) {
  const pathname = usePathname()

  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1 pb-px">
      {tabs.map((tab) => {
        const active = pathname === tab.href || (pathname === "/modules/sales" && tab.href.endsWith("/dashboard"))
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
