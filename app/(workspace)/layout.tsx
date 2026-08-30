import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules } from "@/lib/permissions"
import { AppShell, type NavItem } from "@/components/app-shell"
import { LayoutDashboard, Users2, TrendingUp, Wallet, UserPlus, Settings2, ShieldCheck } from "lucide-react"

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: <Users2 className="size-4" />,
  sales: <TrendingUp className="size-4" />,
  finance: <Wallet className="size-4" />,
  recruitment: <UserPlus className="size-4" />,
  operations: <Settings2 className="size-4" />,
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")

  const modules = await getUserAccessibleModules(session.userId, session.role)

  const navItems: NavItem[] = [
    ...(session.role === "admin"
      ? [{ label: "Admin panel", href: "/admin", icon: <ShieldCheck className="size-4" /> }]
      : [{ label: "Dashboard", href: "/dashboard", icon: <LayoutDashboard className="size-4" /> }]),
    ...modules.map((m) => ({
      label: m.name,
      href: `/modules/${m.slug}`,
      icon: moduleIcons[m.slug] ?? <Settings2 className="size-4" />,
    })),
  ]

  return (
    <AppShell navItems={navItems} user={session}>
      {children}
    </AppShell>
  )
}
