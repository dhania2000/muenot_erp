import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"

export default async function SalesIndexPage() {
  const session = await getSession()
  if (!session) redirect("/login")

  if (session.role === "admin") redirect("/modules/sales/dashboard")

  const has = await getFeatureChecker(session.userId, session.role)
  const order = [
    ["sales.view_dashboard", "/modules/sales/dashboard"],
    ["sales.view_leads", "/modules/sales/leads"],
    ["sales.view_companies", "/modules/sales/companies"],
    ["sales.view_meetings", "/modules/sales/meetings"],
    ["sales.view_quotations", "/modules/sales/quotations"],
    ["sales.view_contracts", "/modules/sales/contracts"],
    ["sales.manage_onboarding", "/modules/sales/onboarding"],
  ] as const

  const first = order.find(([slug]) => has(slug))
  redirect(first ? first[1] : "/dashboard")
}
