import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules } from "@/lib/permissions"
import { PersonalDashboard } from "@/components/dashboard/personal-dashboard"

export default async function DashboardPage() {
  const session = await getSession()
  if (session!.role === "admin") redirect("/admin")
  const modules = await getUserAccessibleModules(session!.userId, session!.role)

  return (
    <PersonalDashboard
      modules={modules.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
        features: m.features,
      }))}
    />
  )
}
