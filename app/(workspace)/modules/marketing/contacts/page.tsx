import { MarketingContactsClient } from "@/components/marketing/marketing-contacts-client"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { query } from "@/lib/db"
import { ensureContactSchema } from "@/lib/marketing/contacts-db"

export const dynamic = "force-dynamic"

export default async function MarketingContactsPage() {
  await ensureContactSchema()
  const session = await getSession()

  const canManage = session
    ? await userHasFeature(session.userId, session.role, "marketing.contacts.manage")
    : false

  // Marketers who can own contacts (used by the owner picker).
  const owners = await query<{ id: number; name: string }[]>(
    `SELECT id, name FROM users WHERE status = 'active' ORDER BY name LIMIT 500`,
  ).catch(() => [])

  return <MarketingContactsClient owners={owners} canManage={canManage} />
}
