import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules } from "@/lib/permissions"
import { AppShell, type NavItem } from "@/components/app-shell"
import { LayoutDashboard, Users2, TrendingUp, Wallet, UserPlus, Settings2 } from "lucide-react"

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role === "admin") redirect("/admin")

  const modules = await getUserAccessibleModules(session.userId, session.role)

  const navItems: NavItem[] = [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    ...modules.map((m) => ({
      label: m.name,
      href: `/modules/${m.slug}`,
      icon: moduleIcons[m.slug] ?? Settings2,
    })),
  ]

  return (
    <AppShell navItems={navItems} user={session}>
      {children}
    </AppShell>
  )
}
