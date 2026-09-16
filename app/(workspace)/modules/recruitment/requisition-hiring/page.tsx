import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { RequisitionHiringClient } from "@/components/recruit/requisition-hiring-client"

export default async function RequisitionHiringPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.requisitions")
  if (!canManage) redirect("/modules/recruitment")
  const canApprove = await userHasFeature(session.userId, session.role, "recruitment.approve_requisitions")
  return <RequisitionHiringClient canManage={canManage} canApprove={canApprove} />
}
