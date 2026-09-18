import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { callPermissions } from "@/lib/calls-core"
import { CallProvider } from "@/components/calls/call-provider"
import { getPublicSettings } from "@/lib/settings/server"
import { SettingsProvider } from "@/components/providers/settings-provider"
import { SettingsBranding } from "@/components/providers/settings-branding"
import { AppShell } from "@/components/app-shell"
import { ImpersonationBanner } from "@/components/platform/impersonation-banner"
import { buildWorkspaceNav } from "@/lib/workspace-nav"

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  const settings = await getPublicSettings()

  // Reuse the exact workspace sidebar so entering an /admin page keeps the same
  // navigation (with Administration expanded) instead of swapping into a
  // separate console shell — the admin routes are just sections of the same app.
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
