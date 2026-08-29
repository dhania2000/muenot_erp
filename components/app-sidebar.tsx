"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { initials } from "@/lib/format"
import { logoutAction } from "@/app/actions/auth"
import { Button } from "@/components/ui/button"
import {
  ChartBar,
  Users,
  Wallet,
  UserSearch,
  Settings2,
  ShieldCheck,
  LogOut,
  ChevronDown,
  CircleDot,
} from "lucide-react"

const MODULE_ICONS: Record<string, any> = {
  sales: ChartBar,
  hr: Users,
  finance: Wallet,
  recruitment: UserSearch,
  operations: Settings2,
}

export type NavModule = {
  key: string
  name: string
  features: { key: string; name: string; href: string; implemented?: boolean }[]
}

export function AppSidebar({
  nav,
  user,
  isAdmin,
}: {
  nav: NavModule[]
  user: { name: string; email: string; role: string }
  isAdmin: boolean
}) {
  const pathname = usePathname()

  return (
    <aside className="flex h-svh w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary font-mono text-sm font-bold text-sidebar-primary-foreground">
          M
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">Muenot ERP</div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-sidebar-foreground/50">
            Enterprise Suite
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {nav.map((mod) => (
          <NavGroup key={mod.key} mod={mod} pathname={pathname} />
        ))}

        {isAdmin ? (
          <div className="mt-4 border-t border-sidebar-border pt-3">
            <div className="px-2 pb-1.5 font-mono text-[10px] uppercase tracking-wider text-sidebar-foreground/40">
              Administration
            </div>
            <NavLink
              href="/admin/users"
              label="Users & Access"
              icon={ShieldCheck}
              active={pathname.startsWith("/admin")}
            />
          </div>
        ) : null}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent font-mono text-xs font-semibold text-sidebar-accent-foreground">
            {initials(user.name)}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-sidebar-foreground/50">{user.email}</div>
          </div>
        </div>
        <form action={logoutAction}>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start gap-2 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  )
}

function NavGroup({ mod, pathname }: { mod: NavModule; pathname: string }) {
  const Icon = MODULE_ICONS[mod.key] ?? CircleDot
  const groupActive = mod.features.some((f) => pathname === f.href || pathname.startsWith(f.href + "/"))
  const [open, setOpen] = useState(groupActive)

  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 text-left">{mod.name}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", open ? "rotate-180" : "")} />
      </button>
      {open ? (
        <div className="mt-0.5 ml-3.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-3">
          {mod.features.map((f) => {
            const active = pathname === f.href || pathname.startsWith(f.href + "/")
            return (
              <Link
                key={f.key}
                href={f.href}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                  active
                    ? "bg-sidebar-primary/15 font-medium text-sidebar-foreground"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                {f.name}
              </Link>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string
  label: string
  icon: any
  active: boolean
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-primary/15 text-sidebar-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </Link>
  )
}
