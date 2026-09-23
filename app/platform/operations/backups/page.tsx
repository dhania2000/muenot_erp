import { Archive } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { BackupsConsole } from "@/components/platform/backups-console"

// SPEC 75 — Platform Backup Operations. A real, tenant-aware backup engine:
// per-tenant + baseline policies, encrypted logical snapshots (database / file
// manifest / configuration), integrity verification, retention and
// non-destructive restore testing. History is never fabricated — a scope shows
// no runs until a policy is enabled or a backup is triggered.
export const dynamic = "force-dynamic"

export default async function BackupsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  const canManage = guard.ctx.platformRole === "platform_super_admin"

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <Archive className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
          <p className="text-sm text-muted-foreground">
            Tenant-aware database, file-manifest and configuration backups with encryption, verification, retention and
            restore testing.
          </p>
        </div>
      </header>
      <BackupsConsole canManage={canManage} />
    </div>
  )
}
