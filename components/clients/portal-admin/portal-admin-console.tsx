"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { NAV_SECTIONS, type PortalSectionId } from "./data"
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

const SECTION_COMPONENTS: Record<PortalSectionId, () => React.ReactElement> = {
  overview: OverviewSection,
  directory: DirectorySection,
  applications: ApplicationsSection,
  onboarding: OnboardingSection,
  access: AccessSection,
  resources: ResourcesSection,
  documents: DocumentsSection,
  requests: RequestsSection,
  invitations: InvitationsSection,
  sessions: SessionsSection,
  communications: CommunicationsSection,
  activity: ActivitySection,
  settings: SettingsSection,
}

export function PortalAdminConsole() {
  const [section, setSection] = useState<PortalSectionId>("overview")
  const Active = SECTION_COMPONENTS[section]

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Section nav */}
      <nav
        aria-label="Portal sections"
        className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 lg:sticky lg:top-4 lg:w-60 lg:shrink-0 lg:flex-col lg:overflow-visible lg:p-2"
      >
        {NAV_SECTIONS.map((s) => {
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
              <span>{s.label}</span>
              {s.badge ? (
                <span
                  className={cn(
                    "ml-auto hidden rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums lg:inline-block",
                    isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted-foreground/15 text-foreground",
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
        <Active />
      </div>
    </div>
  )
}
