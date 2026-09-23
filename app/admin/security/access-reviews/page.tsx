import { requireTenantAdmin } from "@/lib/platform-guard"
import { SecurityHeading } from "@/components/security/security-ui"
import { AccessReviewCampaigns } from "@/components/security/access-review-campaigns"

export const dynamic = "force-dynamic"

export default async function AccessReviewsPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  return (
    <div className="flex flex-col gap-6">
      <SecurityHeading title="Access reviews" spec="">
        Periodically re-certify access across users, roles, permissions, temporary access, API keys, and service accounts.
      </SecurityHeading>
      <AccessReviewCampaigns />
    </div>
  )
}

