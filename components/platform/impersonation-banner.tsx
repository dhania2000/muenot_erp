import { getSession } from "@/lib/auth"
import { resolveRoleContext } from "@/lib/platform-roles"
import { isImpersonating } from "@/lib/role-model"
import { getTenantById } from "@/lib/tenant-service"
import { ExitImpersonationButton } from "./exit-impersonation-button"

/**
 * Persistent, high-visibility warning shown whenever a platform
 * operator is actively impersonating a customer tenant. It exists to satisfy
 * the core requirement that "platform administrators must not accidentally
 * operate with tenant-level permissions": while impersonating, every workspace
 * page is topped by this bar so the operator always knows they are acting
 * inside a customer tenant, and can leave in one click.
 *
 * Renders nothing in normal operation, so it is safe to mount globally.
 */
export async function ImpersonationBanner() {
  const session = await getSession()
  if (!session) return null

  const ctx = await resolveRoleContext({
    userId: session.userId,
    impersonatedTenantId: session.impersonatedTenantId,
  })
  if (!ctx || !isImpersonating(ctx)) return null

  const tenant = ctx.impersonatedTenantId != null ? await getTenantById(ctx.impersonatedTenantId) : null

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-900 dark:text-amber-200">
      <span className="font-medium">
        Impersonating tenant{" "}
        <span className="font-semibold">{tenant?.name ?? `#${ctx.impersonatedTenantId}`}</span>
      </span>
      <span className="text-amber-800/80 dark:text-amber-200/70">
        You are acting with delegated tenant-admin access. Actions are audited.
      </span>
      <ExitImpersonationButton />
    </div>
  )
}
