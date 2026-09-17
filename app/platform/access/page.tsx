import { requirePlatformStaff } from "@/lib/platform-guard"
import { listAccessUsers } from "@/lib/platform-roles"
import { AccessManager } from "@/components/platform/access-manager"

export const dynamic = "force-dynamic"

export default async function AccessPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const users = await listAccessUsers()
  const canAssignSuperAdmin = guard.ctx.platformRole === "platform_super_admin"

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Access &amp; support</h1>
        <p className="text-sm text-muted-foreground">
          Who holds platform authority. Grant or revoke platform roles.{" "}
          {canAssignSuperAdmin
            ? "As a super admin you can mint other super admins."
            : "Only a super admin can grant the super-admin role."}
        </p>
      </header>

      <AccessManager
        users={users}
        currentUserId={guard.session.userId}
        canAssignSuperAdmin={canAssignSuperAdmin}
      />
    </div>
  )
}
