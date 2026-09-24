"use client"

import { useState } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Building2,
  ClipboardCheck,
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MailPlus,
  Megaphone,
  MonitorSmartphone,
  Settings2,
  Share2,
  ShieldCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ACCESS_REQUESTS, APPLICATIONS, INVITATIONS } from "./data"
import { OverviewSection } from "./overview-section"
import { DirectorySection } from "./directory-section"
import { ApplicationsSection } from "./applications-section"
import { OnboardingSection } from "./onboarding-section"
import { AccessSection } from "./access-section"
import { ResourcesSection } from "./resources-section"
import { DocumentsSection } from "./documents-section"
import { RequestsSection } from "./requests-section"
import { InvitationsSection } from "./invitations-section"
import { SessionsSection } from "./sessions-section"
import { CommunicationsSection } from "./communications-section"
import { ActivitySection } from "./activity-section"
import { SettingsSection } from "./settings-section"

export type AdminSectionKey =
  | "overview"
  | "directory"
  | "applications"
  | "onboarding"
  | "access"
  | "resources"
  | "documents"
  | "requests"
  | "invitations"
  | "sessions"
  | "communications"
  | "activity"
  | "settings"

const APPLICATIONS_OPEN = APPLICATIONS.filter(
  (a) => a.status === "pending" || a.status === "under_review" || a.status === "needs_info",
).length
const REQUESTS_OPEN = ACCESS_REQUESTS.filter((r) => r.status === "new" || r.status === "in_review").length
const INVITATIONS_PENDING = INVITATIONS.filter((i) => i.status === "pending").length

const NAV: { id: AdminSectionKey; label: string; icon: LucideIcon; badge?: number }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "directory", label: "Client Directory", icon: Building2 },
  { id: "applications", label: "Applications", icon: ClipboardCheck, badge: APPLICATIONS_OPEN },
  { id: "onboarding", label: "Onboarding Form", icon: ListChecks },
  { id: "access", label: "Access & Roles", icon: ShieldCheck },
  { id: "resources", label: "Shared Resources", icon: Share2 },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "requests", label: "Access Requests", icon: Inbox, badge: REQUESTS_OPEN },
  { id: "invitations", label: "Invitations", icon: MailPlus, badge: INVITATIONS_PENDING },
  { id: "sessions", label: "Sessions", icon: MonitorSmartphone },
  { id: "communications", label: "Communications", icon: Megaphone },
  { id: "activity", label: "Audit & Activity", icon: History },
  { id: "settings", label: "Portal Settings", icon: Settings2 },
]

export function PortalAdminConsole() {
  const [section, setSection] = useState<AdminSectionKey>("overview")

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Section nav */}
      <nav
        aria-label="Portal sections"
        className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 lg:sticky lg:top-4 lg:w-60 lg:shrink-0 lg:flex-col lg:overflow-visible lg:p-2"
      >
        {NAV.map((s) => {
          const isActive = s.id === section
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors lg:w-full",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <s.icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{s.label}</span>
              {s.badge ? (
                <span
                  className={cn(
                    "ml-auto hidden rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums lg:inline-block",
                    isActive
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted-foreground/15 text-foreground",
                  )}
                >
                  {s.badge}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>

      {/* Active section */}
      <div className="min-w-0 flex-1">
        {section === "overview" ? (
          <OverviewSection onNavigate={setSection} />
        ) : section === "directory" ? (
          <DirectorySection />
        ) : section === "applications" ? (
          <ApplicationsSection />
        ) : section === "onboarding" ? (
          <OnboardingSection />
        ) : section === "access" ? (
          <AccessSection />
        ) : section === "resources" ? (
          <ResourcesSection />
        ) : section === "documents" ? (
          <DocumentsSection />
        ) : section === "requests" ? (
          <RequestsSection />
        ) : section === "invitations" ? (
          <InvitationsSection />
        ) : section === "sessions" ? (
          <SessionsSection />
        ) : section === "communications" ? (
          <CommunicationsSection />
        ) : section === "activity" ? (
          <ActivitySection />
        ) : (
          <SettingsSection />
        )}
      </div>
    </div>
  )
}
