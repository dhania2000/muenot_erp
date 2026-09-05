"use client"

import type React from "react"
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { Bell, ChevronDown, Clock3, FileText, LogOut, MessageSquare, Plus, Search, Settings, ShieldCheck, Ticket, UserPlus, UsersRound } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type NavChild = {
  label: string
  href: string
}

export type NavItem = {
  label: string
  href: string
  icon: React.ReactNode
  children?: NavChild[]
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

function NavGroup({ item, pathname }: { item: NavItem; pathname: string }) {
  const groupActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
  const [open, setOpen] = useState(groupActive)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          groupActive
            ? "text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <span className="size-4 shrink-0">{item.icon}</span>
        {item.label}
        <ChevronDown className={cn("ml-auto size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-3 ml-4">
          {item.children!.map((child) => {
            const active = pathname === child.href
            return (
              <Link
                key={child.href}
                href={child.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
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
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/login")
    router.refresh()
  }

  const flatNav = navItems.flatMap((item) =>
    item.children && item.children.length > 0
      ? item.children.map((child) => ({ label: `${item.label} · ${child.label}`, href: child.href }))
      : [{ label: item.label, href: item.href }],
  )
  const searchResults = query.trim()
    ? flatNav.filter((entry) => entry.label.toLowerCase().includes(query.trim().toLowerCase()))
    : flatNav

  function goTo(href: string) {
    setSearchOpen(false)
    setQuery("")
    router.push(href)
  }

  return (
    <div className="flex h-svh overflow-hidden">
      <aside className="hidden h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center px-5 py-5">
          <div className="flex items-center px-1 py-1">
            <Image src="/muenot-logo-transparent.png" alt="Muenot" width={112} height={25} className="h-5 w-auto object-contain" priority />
          </div>
        </div>

        <nav className="min-h-0 flex-1 flex flex-col gap-1 overflow-y-auto px-3">
          {navItems.map((item) => {
            if (item.children && item.children.length > 0) {
              return <NavGroup key={item.href} item={item} pathname={pathname} />
            }
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
                <span className="size-4 shrink-0">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="relative border-t border-sidebar-border p-3">
          {profileOpen && (
            <div className="absolute bottom-20 left-3 z-30 w-72 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl">
              <div className="flex items-center gap-3 border-b border-border pb-4">
                <Avatar className="size-11"><AvatarFallback className="bg-primary text-primary-foreground">{initials(user.name)}</AvatarFallback></Avatar>
                <div className="min-w-0"><p className="truncate font-semibold">{user.name}</p><p className="truncate text-xs text-muted-foreground">{user.role === "admin" ? "Administrator" : "Employee"}</p></div>
                <Link href="/profile" className="ml-auto rounded-md p-2 text-muted-foreground hover:bg-muted" aria-label="Edit profile"><FileText className="size-4" /></Link>
              </div>
              <div className="flex flex-col gap-1 pt-3">
                {user.role === "admin" && <Link href="/modules/hr/employees" className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"><UserPlus className="size-4" /> Add employee</Link>}
                <div className="flex items-center justify-between rounded-md px-2 py-2 text-sm"><span className="flex items-center gap-3"><ThemeToggle /> Dark mode</span></div>
                <button type="button" onClick={handleLogout} className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"><LogOut className="size-4" /> Logout</button>
              </div>
            </div>
          )}
          {user.role === "admin" && (
            <div className="mb-3 flex items-center gap-2 rounded-md bg-sidebar-primary/10 px-3 py-2 text-xs font-medium text-sidebar-primary">
              <ShieldCheck className="size-3.5" />
              Administrator
            </div>
          )}
          <button type="button" onClick={() => setProfileOpen((v) => !v)} aria-expanded={profileOpen} className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-sidebar-accent/60">
            <Avatar className="size-8">
              <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-xs">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{user.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/60">{user.email}</span>
            </div>
          </button>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start gap-2 text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground" onClick={handleLogout}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3 md:px-8">
          <div className="flex items-center gap-3"><span className="text-lg font-semibold tracking-tight">Dashboard</span></div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Search" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => setSearchOpen(true)}><Search className="size-5" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Messages" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => router.push("/modules/messages")}><MessageSquare className="size-5" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Recent activity" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" />}>
                <Clock3 className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Recent activity</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-sm text-muted-foreground">No recent activity yet</p>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Create" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" />}>
                <Plus className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Quick create</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {user.role === "admin" && (
                  <DropdownMenuItem onClick={() => router.push("/modules/hr/employees")}>
                    <UserPlus className="size-4" /> Add employee
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => router.push("/modules/tickets/all")}>
                  <Ticket className="size-4" /> New ticket
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/modules/clients")}>
                  <UsersRound className="size-4" /> New client
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Notifications" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" />}>
                <Bell className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Notifications</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-sm text-muted-foreground">You&apos;re all caught up</p>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-primary/10 hover:text-primary" onClick={() => router.push("/admin/settings")} aria-label="Settings"><Settings className="size-5" /></Button>
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={handleLogout} aria-label="Sign out"><LogOut className="size-4" /></Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <Dialog open={searchOpen} onOpenChange={(open) => { setSearchOpen(open); if (!open) setQuery("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Search</DialogTitle>
          </DialogHeader>
          <Input autoFocus placeholder="Search modules and pages..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pt-2">
            {searchResults.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No results found</p>}
            {searchResults.map((entry) => (
              <button
                key={entry.href}
                type="button"
                onClick={() => goTo(entry.href)}
                className="rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
