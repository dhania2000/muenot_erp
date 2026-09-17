import { requirePlatformStaff } from "@/lib/platform-guard"
import { listOnboarding } from "@/lib/tenant-onboarding"
import { OnboardingList, type OnboardingSummary } from "@/components/platform/onboarding-list"

export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const sessions = await listOnboarding()
  const canManage = guard.ctx.platformRole === "platform_super_admin"

  const rows: OnboardingSummary[] = sessions.map((s) => ({
    id: s.id,
    status: s.status,
    currentStep: s.currentStep,
    companyName: s.data.companyName ?? null,
    slug: s.data.slug ?? null,
    plan: s.data.plan ?? null,
    createdTenantId: s.createdTenantId,
    errorMessage: s.errorMessage,
    updatedAt: s.updatedAt,
  }))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Organization onboarding</h1>
        <p className="text-sm text-muted-foreground">
          Provision new customer organizations through a guided, resumable setup. Progress is saved at every step, so
          an onboarding can be paused and continued later, and a failed provisioning run can be retried without
          duplicating anything.{" "}
          {canManage
            ? "As a super admin you can start, edit and provision organizations."
            : "Starting and provisioning requires platform super-admin authority."}
        </p>
      </header>

      <OnboardingList sessions={rows} canManage={canManage} />
    </div>
  )
}
