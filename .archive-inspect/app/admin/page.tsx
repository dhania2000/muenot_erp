import { query } from "@/lib/db"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2, UsersRound } from "lucide-react"
import Link from "next/link"

const moduleIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
}

export default async function AdminOverviewPage() {
  const [employeeCountRows, moduleStats] = await Promise.all([
    query<{ total: number; active: number }[]>(
      `SELECT COUNT(*) as total, SUM(status = 'active') as active FROM users WHERE role = 'employee'`,
    ),
    query<{ slug: string; name: string; granted: number }[]>(
      `SELECT m.slug, m.name, COUNT(DISTINCT up.user_id) as granted
       FROM modules m
       LEFT JOIN features f ON f.module_id = m.id
       LEFT JOIN user_permissions up ON up.feature_id = f.id
       GROUP BY m.id, m.slug, m.name
       ORDER BY m.sort_order ASC`,
    ),
  ])

  const employeeCount = employeeCountRows[0] || { total: 0, active: 0 }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Manage employee access across all modules from one place.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total employees</CardTitle>
            <UsersRound className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{employeeCount.total}</div>
            <p className="mt-1 text-xs text-muted-foreground">{employeeCount.active} active</p>
          </CardContent>
        </Card>

        {moduleStats.map((m) => {
          const Icon = moduleIcons[m.slug] ?? Settings2
          return (
            <Card key={m.slug}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{m.name}</CardTitle>
                <Icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold">{m.granted}</div>
                <p className="mt-1 text-xs text-muted-foreground">employees with access</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Get started</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            Head over to{" "}
            <Link href="/admin/employees" className="font-medium text-primary underline-offset-4 hover:underline">
              Employees
            </Link>{" "}
            to invite new team members and assign exactly which module features each person can use.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
