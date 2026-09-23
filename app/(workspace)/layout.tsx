import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { callPermissions } from "@/lib/calls-core"
import { CallProvider } from "@/components/calls/call-provider"
import { getPublicSettings } from "@/lib/settings/server"
import { SettingsProvider } from "@/components/providers/settings-provider"
import { SettingsBranding } from "@/components/providers/settings-branding"
import { AppShell } from "@/components/app-shell"
import { ImpersonationBanner } from "@/components/platform/impersonation-banner"
import { EmergencyAccessBanner } from "@/components/security/emergency-access-banner"
import { buildWorkspaceNav } from "@/lib/workspace-nav"

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")

  const settings = await getPublicSettings()

  // Internal calling: mount the provider app-wide so every signed-in user
  // maintains presence and can receive incoming calls, regardless of whether
  // they hold place-call permissions.
  const callPerms = await callPermissions(session)

  const navItems = await buildWorkspaceNav(session, settings)

  return (
    <SettingsProvider initial={settings}>
      <SettingsBranding />
      <CallProvider currentUserId={session.userId} permissions={callPerms}>
        <AppShell navItems={navItems} user={session} brandName={settings["company.name"]} logoUrl={settings["company.logo"]}>
          <ImpersonationBanner />
          {children}
        </AppShell>
      </CallProvider>
    </SettingsProvider>
  )
}
