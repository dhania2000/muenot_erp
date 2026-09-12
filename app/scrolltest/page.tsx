"use client"

import { Users } from "lucide-react"
import { AppShell, type NavItem } from "@/components/app-shell"
import { HrEmailHub } from "@/components/hr/hr-email-hub"

const navItems: NavItem[] = [
  { label: "Admin panel", href: "/admin", icon: <Users /> },
  {
    label: "HR",
    href: "/modules/hr",
    icon: <Users />,
    children: [
      { label: "HR Dashboard", href: "/modules/hr" },
      { label: "Employees", href: "/modules/hr/employees" },
      { label: "Employee Documents", href: "/modules/hr/documents" },
      { label: "Attendance", href: "/modules/hr/attendance" },
      { label: "Attendance Regularisation", href: "/modules/hr/attendance/regularise" },
      { label: "HR Support", href: "/modules/hr/support" },
      { label: "Offboarding", href: "/modules/hr/offboarding" },
      { label: "HR Emails", href: "/modules/hr/emails" },
      { label: "HR Master Data", href: "/modules/hr/master" },
    ],
  },
]

export default function ScrollTestPage() {
  return (
    <AppShell
      navItems={navItems}
      user={{ name: "System Admin", email: "contact@muenot.co.in", role: "admin" }}
      brandName="Muenot Technologies"
    >
      <HrEmailHub />
    </AppShell>
  )
}
