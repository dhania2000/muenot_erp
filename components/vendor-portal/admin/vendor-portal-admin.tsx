"use client"

import { useState } from "react"
import {
  LayoutDashboard,
  Users,
  FileSearch,
  ClipboardList,
  UserCog,
  SlidersHorizontal,
  Wallet,
  Landmark,
  Send,
  MessageSquare,
  MonitorSmartphone,
  ScrollText,
  Settings2,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { OverviewSection } from "./overview-section"
import { DirectorySection } from "./directory-section"
import { ApplicationsSection } from "./applications-section"
import { OnboardingSection } from "./onboarding-section"
import { UsersSection } from "./users-section"
import { AccessSection } from "./access-section"
import { FinanceControlSection } from "./finance-control-section"
import { BankComplianceSection } from "./bank-compliance-section"
import { InvitationsSection } from "./invitations-section"
import { CommunicationSection } from "./communication-section"
import { SessionsSecuritySection } from "./sessions-security-section"
import { AuditSection } from "./audit-section"
import { SettingsSection } from "./settings-section"

export type SectionKey =
  | "overview"
  | "directory"
  | "applications"
  | "onboarding"
  | "users"
  | "access"
  | "finance"
  | "bank"
  | "invitations"
  | "communication"
  | "sessions"
  | "audit"
  | "settings"

type NavGroup = {
  label: string
  items: { key: SectionKey; label: string; icon: LucideIcon }[]
}

const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ key: "overview", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Vendors",
    items: [
      { key: "directory", label: "Vendor Directory", icon: Users },
      { key: "applications", label: "Applications", icon: FileSearch },
      { key: "onboarding", label: "Onboarding Form", icon: ClipboardList },
      { key: "users", label: "User Accounts", icon: UserCog },
    ],
  },
  {
    label: "Access & Finance",
    items: [
      { key: "access", label: "Access & Permissions", icon: SlidersHorizontal },
      { key: "finance", label: "Finance Control", icon: Wallet },
      { key: "bank", label: "Bank & Compliance", icon: Landmark },
    ],
  },
  {
    label: "Engagement",
    items: [
      { key: "invitations", label: "Invitations", icon: Send },
      { key: "communication", label: "Communication", icon: MessageSquare },
    ],
  },
  {
    label: "Governance",
    items: [
      { key: "sessions", label: "Sessions & Security", icon: MonitorSmartphone },
      { key: "audit", label: "Audit Logs", icon: ScrollText },
      { key: "settings", label: "Portal Settings", icon: Settings2 },
    ],
  },
]

const ALL_ITEMS = NAV.flatMap((g) => g.items)

export function VendorPortalAdmin() {
  const [section, setSection] = useState<SectionKey>("overview")

  function renderSection() {
    switch (section) {
      case "overview":
        return <OverviewSection onNavigate={setSection} />
      case "directory":
        return <DirectorySection />
      case "applications":
        return <ApplicationsSection />
      case "onboarding":
        return <OnboardingSection />
      case "users":
        return <UsersSection />
      case "access":
        return <AccessSection />
      case "finance":
        return <FinanceControlSection />
      case "bank":
        return <BankComplianceSection />
      case "invitations":
        return <InvitationsSection />
      case "communication":
        return <CommunicationSection />
      case "sessions":
        return <SessionsSecuritySection />
      case "audit":
        return <AuditSection />
      case "settings":
        return <SettingsSection />
      default:
        return null
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
      {/* Desktop rail */}
      <nav
        aria-label="Vendor portal sections"
        className="hidden lg:sticky lg:top-4 lg:grid lg:gap-4 lg:self-start"
      >
        {NAV.map((group) => (
          <div key={group.label} className="grid gap-1">
            <p className="px-2 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active = section === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSection(item.key)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Mobile / tablet horizontal nav */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 lg:hidden">
        <div className="flex w-max gap-1.5">
          {ALL_ITEMS.map((item) => {
            const active = section === item.key
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition-colors",
                  active
                    ? "border-primary/40 bg-primary/10 font-medium text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="size-3.5 shrink-0" />
                {item.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-w-0">{renderSection()}</div>
    </div>
  )
}
