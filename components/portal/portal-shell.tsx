"use client"

import type React from "react"
import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { PORTAL_RESOURCE_META, type PortalResource } from "@/lib/portal/config"
import {
  FileText,
  ShoppingCart,
  ReceiptText,
  CreditCard,
  FolderOpen,
  LifeBuoy,
  Briefcase,
  MessagesSquare,
  LayoutDashboard,
  LogOut,
  Menu,
} from "lucide-react"

const RESOURCE_ICON: Record<PortalResource, React.ComponentType<{ className?: string }>> = {
  quotes: FileText,
  orders: ShoppingCart,
  invoices: ReceiptText,
  payments: CreditCard,
  documents: FolderOpen,
  tickets: LifeBuoy,
  projects: Briefcase,
  messages: MessagesSquare,
}

type NavProps = {
  resources: PortalResource[]
  user: { name: string; email: string }
  clientName: string | null
}

function NavLinks({ resources, onNavigate }: { resources: PortalResource[]; onNavigate?: () => void }) {
  const pathname = usePathname()
  const items = [
    { href: "/portal", label: "Dashboard", Icon: LayoutDashboard, active: pathname === "/portal" },
    ...resources.map((r) => ({
      href: `/portal/${r}`,
      label: PORTAL_RESOURCE_META[r].labelPlural,
      Icon: RESOURCE_ICON[r],
      active: pathname === `/portal/${r}` || pathname.startsWith(`/portal/${r}/`),
    })),
  ]
  return (
    <nav className="flex flex-col gap-1" aria-label="Portal sections">
      {items.map(({ href, label, Icon, active }) => (
        <Link
          key={href}
          href={href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  )
}

export function PortalShell({
  resources,
  user,
  clientName,
  children,
}: NavProps & { children: React.ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    setSigningOut(true)
    await fetch("/api/portal/auth/logout", { method: "POST" })
    router.replace("/portal/login")
    router.refresh()
  }

  const brand = (
    <div className="flex flex-col">
      <span className="text-sm font-semibold leading-tight">{clientName ?? "Client portal"}</span>
      <span className="text-xs text-muted-foreground">Client portal</span>
    </div>
  )

  return (
    <div className="flex min-h-svh flex-col bg-muted/20 md:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-background md:flex">
        <div className="flex h-16 items-center border-b border-border px-4">{brand}</div>
        <div className="flex-1 overflow-y-auto p-3">
          <NavLinks resources={resources} />
        </div>
        <div className="border-t border-border p-3">
          <div className="mb-2 px-3">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={signOut} disabled={signingOut}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <header className="flex h-16 items-center justify-between gap-3 border-b border-border bg-background px-4 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open navigation">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="sr-only">Portal navigation</SheetTitle>
              <div className="flex h-16 items-center border-b border-border px-4">{brand}</div>
              <div className="p-3">
                <NavLinks resources={resources} onNavigate={() => setOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          {brand}
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={signOut} disabled={signingOut}>
            <LogOut className="h-5 w-5" />
          </Button>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  )
}
