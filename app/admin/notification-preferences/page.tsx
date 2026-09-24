import { requireTenantRole } from "@/lib/platform-guard"
import { PERMISSION_GROUPS } from "@/lib/permission-model"
import { NotificationPreferences } from "@/components/notification-preferences"

export const dynamic = "force-dynamic"

// SPEC 153 — Notification Preferences
export default async function NotificationPreferencesPage() {
  const g = await requireTenantRole("employee")
  if (!g.ok) return <p className="p-6">Sign in to your tenant account to manage notification preferences.</p>
  const moduleCatalog = PERMISSION_GROUPS.map((group) => ({ key: group.slug, label: group.label }))
  return (
    <main className="mx-auto max-w-3xl p-6">
      <NotificationPreferences moduleCatalog={moduleCatalog} />
    </main>
  )
}
