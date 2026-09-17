import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeft } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getOnboarding } from "@/lib/tenant-onboarding"
import { OnboardingWizard, type OnboardingSession } from "@/components/platform/onboarding-wizard"

export const dynamic = "force-dynamic"

export default async function OnboardingWizardPage({ params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const record = await getOnboarding(id)
  if (!record) notFound()

  const canManage = guard.ctx.platformRole === "platform_super_admin"

  const session: OnboardingSession = {
    id: record.id,
    status: record.status,
    currentStep: record.currentStep,
    data: record.data,
    createdTenantId: record.createdTenantId,
    errorMessage: record.errorMessage,
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/platform/onboarding"
          className="flex w-max items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          All onboarding sessions
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {record.data.companyName || "New organization"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "Complete each step to build the organization profile, then provision it."
              : "Read-only view — provisioning requires platform super-admin authority."}
          </p>
        </header>
      </div>

      <OnboardingWizard session={session} canManage={canManage} />
    </div>
  )
}
