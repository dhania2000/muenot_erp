import { redirect } from "next/navigation"
import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { platformRoleLabel } from "@/lib/role-model"
import { PlatformNav } from "@/components/platform/platform-nav"

/**
 * SPEC 3/4 — The Muenot PLATFORM console shell. Access is gated on the platform
 * axis ALONE (`requirePlatformStaff`); a customer's tenant_owner/tenant_admin
 * can never reach it. This is deliberately a separate route tree from the
 * tenant workspace so operating the platform and operating a tenant are
 * physically distinct surfaces.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) {
    // Authenticated tenant users are sent back to their workspace; anonymous
    // requests to log in. Either way, no platform surface is exposed.
    redirect(guard.status === 401 ? "/login" : "/dashboard")
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex max-w-[90rem] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/platform" className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" />
            </span>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold">Muenot Platform</span>
              <span className="text-xs text-muted-foreground">Operator console</span>
            </div>
          </Link>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-sm font-medium">{guard.session.name}</span>
            <span className="text-xs text-muted-foreground">{platformRoleLabel(guard.ctx.platformRole)}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[90rem] gap-8 px-4 py-6 sm:px-6 lg:py-8">
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-[4.5rem]">
            <PlatformNav />
          </div>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
