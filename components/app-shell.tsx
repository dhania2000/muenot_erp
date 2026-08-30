"use client"

import type React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { LogOut, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

export type NavItem = {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export function AppShell({
  navItems,
  user,
  children,
}: {
  navItems: NavItem[]
  user: { name: string; email: string; role: "admin" | "employee" }
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/login")
    router.refresh()
  }

  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center px-5 py-5">
          <div className="flex items-center rounded-md bg-white px-2.5 py-1.5">
            <Image src="/muenot-logo.png" alt="Muenot" width={140} height={36} className="h-6 w-auto" priority />
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3">
          {navItems.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          {user.role === "admin" && (
            <div className="mb-3 flex items-center gap-2 rounded-md bg-sidebar-primary/10 px-3 py-2 text-xs font-medium text-sidebar-primary">
              <ShieldCheck className="size-3.5" />
              Administrator
            </div>
          )}
          <div className="flex items-center gap-2.5 px-1">
            <Avatar className="size-8">
              <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-xs">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{user.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/60">{user.email}</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start gap-2 text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground" onClick={handleLogout}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-h-svh flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
          <div className="flex items-center rounded-md bg-white px-2 py-1">
            <Image src="/muenot-logo.png" alt="Muenot" width={120} height={30} className="h-5 w-auto" />
          </div>
          <Button variant="ghost" size="icon-sm" onClick={handleLogout} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
