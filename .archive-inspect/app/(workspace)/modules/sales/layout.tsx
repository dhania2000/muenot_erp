import type React from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserFeatureSlugs } from "@/lib/permissions"

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

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales CRM</h1>
        <p className="text-sm text-muted-foreground">Leads, pipeline, quotations, contracts, and forecasting.</p>
      </div>
      <div>{children}</div>
    </div>
  )
}
