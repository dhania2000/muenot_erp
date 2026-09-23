import { redirect } from "next/navigation"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { listReleases } from "@/lib/mobile-app-releases"
import { MobileReleaseManager } from "@/components/platform/mobile-release-manager"

export const dynamic = "force-dynamic"

export default async function MobileReleasesPage() {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) redirect(guard.status === 401 ? "/login" : "/platform")
  const releases = await listReleases()
  return <div className="space-y-6"><header><h1 className="text-2xl font-semibold">Mobile App · Releases</h1><p className="mt-1 text-sm text-muted-foreground">Manage reviewed Android APK releases. Publishing is a separate Super Admin action.</p></header><MobileReleaseManager initialReleases={releases} /></div>
}
