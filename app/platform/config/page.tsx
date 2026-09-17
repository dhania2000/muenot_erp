import { requirePlatformStaff } from "@/lib/platform-guard"
import { listConfig } from "@/lib/platform-console"
import { ConfigManager } from "@/components/platform/config-manager"

export const dynamic = "force-dynamic"

export default async function ConfigPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const config = await listConfig()
  const canEdit = guard.ctx.platformRole === "platform_super_admin"

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide settings.{" "}
          {canEdit ? "Edit a value inline to update it." : "Editing requires platform super-admin authority."}
        </p>
      </header>

      <ConfigManager entries={config} canEdit={canEdit} />
    </div>
  )
}
