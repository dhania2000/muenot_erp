import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { AppShell, type NavItem } from "@/components/app-shell"
import { LayoutDashboard, Users } from "lucide-react"

const navItems: NavItem[] = [
  { label: "Overview", href: "/admin", icon: <LayoutDashboard className="size-4" /> },
  { label: "Employees", href: "/admin/employees", icon: <Users className="size-4" /> },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  return (
    <AppShell navItems={navItems} user={session}>
      {children}
    </AppShell>
  )
}
