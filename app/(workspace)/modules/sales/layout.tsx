import type React from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserFeatureSlugs } from "@/lib/permissions"
import { SalesTabs } from "@/components/sales/sales-tabs"

export default async function SalesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")

  const granted =
    session.role === "admin" ? null : new Set(await getUserFeatureSlugs(session.userId))
  const has = (slug: string) => session.role === "admin" || granted!.has(slug)

  if (!has("sales.view_dashboard") && !has("sales.view_leads") && !has("sales.view_companies") &&
      !has("sales.view_meetings") && !has("sales.view_quotations") && !has("sales.view_contracts") &&
      !has("sales.manage_onboarding")) {
    redirect("/dashboard")
  }

  const tabs = [
    { label: "Dashboard", href: "/modules/sales/dashboard", show: has("sales.view_dashboard") },
    { label: "Leads", href: "/modules/sales/leads", show: has("sales.view_leads") },
    { label: "Companies", href: "/modules/sales/companies", show: has("sales.view_companies") },
    { label: "Meetings", href: "/modules/sales/meetings", show: has("sales.view_meetings") },
    { label: "Quotations", href: "/modules/sales/quotations", show: has("sales.view_quotations") },
    { label: "Contracts", href: "/modules/sales/contracts", show: has("sales.view_contracts") },
    { label: "Onboarding", href: "/modules/sales/onboarding", show: has("sales.manage_onboarding") },
    { label: "Forecast", href: "/modules/sales/forecast", show: has("sales.view_dashboard") },
  ].filter((t) => t.show)

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales CRM</h1>
        <p className="text-sm text-muted-foreground">Leads, pipeline, quotations, contracts, and forecasting.</p>
      </div>
      <SalesTabs tabs={tabs} />
      <div>{children}</div>
    </div>
  )
}
