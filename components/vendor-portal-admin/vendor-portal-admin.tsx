"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  LayoutDashboard,
  Users,
  ClipboardList,
  Send,
  KeySquare,
  SlidersHorizontal,
  ShieldCheck,
  Landmark,
  BadgeCheck,
  FileText,
  Wallet,
  MonitorSmartphone,
  MessageSquare,
  Megaphone,
  ScrollText,
  Settings2,
  DoorOpen,
  Menu,
  ExternalLink,
} from "lucide-react"

import { OverviewSection } from "@/components/vendor-portal-admin/sections/overview"
import { DirectorySection } from "@/components/vendor-portal-admin/sections/directory"
import { ApplicationsSection } from "@/components/vendor-portal-admin/sections/applications"
import { InvitationsSection } from "@/components/vendor-portal-admin/sections/invitations"
import { AccessRequestsSection } from "@/components/vendor-portal-admin/sections/access-requests"
import { OnboardingBuilderSection } from "@/components/vendor-portal-admin/sections/onboarding-builder"
import { AccessControlSection } from "@/components/vendor-portal-admin/sections/access-control"
import { BankSection } from "@/components/vendor-portal-admin/sections/bank"
import { ComplianceSection } from "@/components/vendor-portal-admin/sections/compliance"
import { DocumentsSection } from "@/components/vendor-portal-admin/sections/documents"
import { FinanceControlSection } from "@/components/vendor-portal-admin/sections/finance-control"
import { SessionsSecuritySection } from "@/components/vendor-portal-admin/sections/sessions-security"
import { CommunicationSection } from "@/components/vendor-portal-admin/sections/communication"
import { AnnouncementsSection } from "@/components/vendor-portal-admin/sections/announcements"
import { AuditSection } from "@/components/vendor-portal-admin/sections/audit"
import { SettingsSection } from "@/components/vendor-portal-admin/sections/settings"

export type ConsoleSection =
  | "overview"
  | "directory"
  | "applications"
  | "invitations"
  | "access-requests"
  | "onboarding"
  | "access"
  | "bank"
  | "compliance"
  | "documents"
  | "finance"
  | "sessions"
  | "communication"
  | "announcements"
  | "audit"
  | "settings"

type NavItem = {
  key: ConsoleSection
  label: string
  icon: React.ElementType
  badge?: number
}

type NavGroup = { heading: string; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      { key: "overview", label: "Dashboard", icon: LayoutDashboard },
      { key: "directory", label: "Vendor Directory", icon: Users },
    ],
  },
  {
    heading: "Onboarding",
    items: [
      { key: "applications", label: "Applications", icon: ClipboardList, badge: 14 },
      { key: "invitations", label: "Invitations", icon: Send },
      { key: "access-requests", label: "Access Requests", icon: KeySquare, badge: 9 },
      { key: "onboarding", label: "Onboarding Builder", icon: SlidersHorizontal },
    ],
  },
  {
    heading: "Access & Finance",
    items: [
      { key: "access", label: "Access & Profiles", icon: ShieldCheck },
      { key: "bank", label: "Bank Details", icon: Landmark, badge: 2 },
      { key: "compliance", label: "Tax & Compliance", icon: BadgeCheck },
      { key: "documents", label: "Documents", icon: FileText, badge: 37 },
      { key: "finance", label: "Finance Control", icon: Wallet },
    ],
  },
  {
    heading: "Security & Comms",
    items: [
      { key: "sessions", label: "Sessions & Security", icon: MonitorSmartphone },
      { key: "communication", label: "Communication", icon: MessageSquare },
      { key: "announcements", label: "Announcements", icon: Megaphone },
      { key: "audit", label: "Audit Logs", icon: ScrollText },
      { key: "settings", label: "Portal Settings", icon: Settings2 },
    ],
  },
]

const SECTION_META: Record<ConsoleSection, { title: string; crumb: string }> = {
  overview: { title: "Overview", crumb: "Dashboard" },
  directory: { title: "Vendor Directory", crumb: "Directory" },
  applications: { title: "Applications", crumb: "Applications" },
  invitations: { title: "Invitations", crumb: "Invitations" },
  "access-requests": { title: "Access Requests", crumb: "Access Requests" },
  onboarding: { title: "Onboarding Builder", crumb: "Onboarding" },
  access: { title: "Access & Profiles", crumb: "Access" },
  bank: { title: "Bank Details", crumb: "Bank" },
  compliance: { title: "Tax & Compliance", crumb: "Compliance" },
  documents: { title: "Documents", crumb: "Documents" },
  finance: { title: "Finance Control", crumb: "Finance" },
  sessions: { title: "Sessions & Security", crumb: "Sessions" },
  communication: { title: "Communication", crumb: "Communication" },
  announcements: { title: "Announcements", crumb: "Announcements" },
  audit: { title: "Audit Logs", crumb: "Audit" },
  settings: { title: "Portal Settings", crumb: "Settings" },
}

export function VendorPortalAdminConsole() {
  const [section, setSection] = useState<ConsoleSection>("overview")
  const [navOpen, setNavOpen] = useState(false)

  const go = (s: ConsoleSection) => {
    setSection(s)
    setNavOpen(false)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[248px_1fr]">
      {/* Sidebar nav */}
      <aside
        className={cn(
          "flex flex-col rounded-xl border border-border bg-card lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]",
          navOpen ? "block" : "hidden lg:flex",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <DoorOpen className="size-4" />
          </div>
          <div className="grid gap-0.5">
            <span className="text-sm font-semibold leading-none">Vendor Portal</span>
            <span className="text-[11px] text-muted-foreground">Admin control center</span>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <nav className="grid gap-4 p-3">
            {NAV.map((group) => (
              <div key={group.heading} className="grid gap-1">
                <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.heading}
                </p>
                {group.items.map((item) => {
                  const active = item.key === section
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => go(item.key)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                        active
                          ? "bg-primary/10 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                    >
                      <item.icon className={cn("size-4 shrink-0", active ? "text-primary" : "")} />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge ? (
                        <Badge variant="outline" className="h-4 px-1 text-[10px] tabular-nums">
                          {item.badge}
                        </Badge>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        </ScrollArea>
        <div className="border-t border-border p-3">
          <Button asChild variant="outline" size="sm" className="w-full justify-start gap-2">
            <a href="/vendor-portal" target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Open external portal
            </a>
          </Button>
        </div>
      </aside>

      {/* Content */}
      <section className="min-w-0">
        <div className="mb-4 flex items-center gap-3">
          <Button
            variant="outline"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setNavOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            <Menu className="size-4" />
          </Button>
          <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
            <span>Finance</span>
            <span aria-hidden>/</span>
            <span>Vendor Portal</span>
            <span aria-hidden>/</span>
            <span className="font-medium text-foreground">{SECTION_META[section].crumb}</span>
          </nav>
        </div>

        {section === "overview" && <OverviewSection onNavigate={go} />}
        {section === "directory" && <DirectorySection />}
        {section === "applications" && <ApplicationsSection />}
        {section === "invitations" && <InvitationsSection />}
        {section === "access-requests" && <AccessRequestsSection />}
        {section === "onboarding" && <OnboardingBuilderSection />}
        {section === "access" && <AccessControlSection />}
        {section === "bank" && <BankSection />}
        {section === "compliance" && <ComplianceSection />}
        {section === "documents" && <DocumentsSection />}
        {section === "finance" && <FinanceControlSection />}
        {section === "sessions" && <SessionsSecuritySection />}
        {section === "communication" && <CommunicationSection />}
        {section === "announcements" && <AnnouncementsSection />}
        {section === "audit" && <AuditSection />}
        {section === "settings" && <SettingsSection />}
      </section>
    </div>
  )
}
