import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { DashboardEngine } from "@/components/dashboards/dashboard-engine"

export const metadata = {
  title: "Dashboards",
  description: "Configurable dashboards with KPIs, charts, tables and filters.",
}

export default async function DashboardsPage() {
  const session = await getSession()
  if (!session) redirect("/login")

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboards</h1>
        <p className="text-sm text-muted-foreground">
          Build and save configurable dashboards from KPIs, charts and tables. Filter by date range, department and
          module, then share them across your role or organization.
        </p>
      </div>
      <DashboardEngine />
    </div>
  )
}
