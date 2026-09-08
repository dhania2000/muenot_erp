import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getAllModulesWithFeatures } from "@/lib/permissions"
import { getPublicSettings } from "@/lib/settings/server"
import { SettingsProvider } from "@/components/providers/settings-provider"
import { SettingsBranding } from "@/components/providers/settings-branding"
import { AppShell, type NavItem } from "@/components/app-shell"
import { LayoutDashboard, Users2, TrendingUp, Wallet, UserPlus, Settings2, Settings } from "lucide-react"

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: <Users2 className="size-4" />,
  sales: <TrendingUp className="size-4" />,
  finance: <Wallet className="size-4" />,
  recruitment: <UserPlus className="size-4" />,
  operations: <Settings2 className="size-4" />,
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  const settings = await getPublicSettings()

  const HIDDEN_MODULES = new Set(["biolinks", "biometric", "letter", "monitor-center", "monitor center"])
  const modules = (await getAllModulesWithFeatures()).filter(
    (m) => !HIDDEN_MODULES.has(m.slug.toLowerCase()) && !HIDDEN_MODULES.has(m.name.toLowerCase()),
  )

  const navItems: NavItem[] = [
    { label: "Overview", href: "/admin", icon: <LayoutDashboard className="size-4" /> },
    { label: "Settings", href: "/admin/settings", icon: <Settings className="size-4" />, children: [{ label: "Company Settings", href: "/admin/settings" }, { label: "Environment variables", href: "/admin/settings" }] },
    ...modules.map((m) => ({
      label: m.name,
      href: `/modules/${m.slug}`,
      icon: moduleIcons[m.slug] ?? <Settings2 className="size-4" />,
    })),
  ]

  return (
    <SettingsProvider initial={settings}>
      <SettingsBranding />
      <AppShell navItems={navItems} user={session} brandName={settings["company.name"]} logoUrl={settings["company.logo"]}>
        {children}
      </AppShell>
    </SettingsProvider>
  )
}
