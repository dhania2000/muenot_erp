import { MarketingJourneysClient } from "@/components/marketing/marketing-journeys-client"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureJourneySchema } from "@/lib/marketing/journeys-db"

export const dynamic = "force-dynamic"

export default async function MarketingJourneysPage() {
  await ensureJourneySchema()
  const session = await getSession()

  const canManage = session
    ? await userHasFeature(session.userId, session.role, "marketing.journeys.manage")
    : false

  return <MarketingJourneysClient canManage={canManage} />
}
