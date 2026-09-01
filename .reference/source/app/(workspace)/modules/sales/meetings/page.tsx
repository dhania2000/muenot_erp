import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { MeetingsClient } from "@/components/sales/meetings-client"

export default async function MeetingsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_meetings")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_meetings")

  return <MeetingsClient canManage={canManage} />
}
