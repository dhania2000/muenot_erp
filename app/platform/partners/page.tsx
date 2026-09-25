import { requirePlatformStaff } from "@/lib/platform-guard"
import { PartnerManager } from "@/components/platform/partner-manager"

export const dynamic = "force-dynamic"

export default async function PartnersPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  const canManage = guard.ctx.platformRole === "platform_super_admin"

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Partners &amp; resellers</h1>
        <p className="text-sm text-muted-foreground text-pretty">
          Partner organizations, customer attribution, contract terms and the commission ledger. Commissions settle only
          after an invoice is verified paid and the partner&apos;s refund window has elapsed; refunds and voids claw back
          automatically.
          {canManage ? "" : " Changes require platform super-admin authority."}
        </p>
      </header>
      <PartnerManager canManage={canManage} />
    </div>
  )
}
