import Link from "next/link"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules } from "@/lib/permissions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowRight, Users2, TrendingUp, Wallet, UserPlus, Settings2, Inbox } from "lucide-react"

const moduleIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
}

export default async function DashboardPage() {
  const session = await getSession()
  if (session!.role === "admin") redirect("/admin")
  const modules = await getUserAccessibleModules(session!.userId, session!.role)

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {session!.name.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground">
          Here are the modules you currently have access to.
        </p>
      </div>

      {modules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Inbox className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="font-medium">No module access yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Your administrator hasn&apos;t granted you access to any features yet. Reach out to them to get
                started.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => {
            const Icon = moduleIcons[m.slug] ?? Settings2
            return (
              <Link key={m.slug} href={`/modules/${m.slug}`} className="group">
                <Card className="h-full transition-colors group-hover:border-primary/40">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Icon className="size-4" />
                      </div>
                      <CardTitle className="text-base">{m.name}</CardTitle>
                    </div>
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </CardHeader>
                  <CardContent>
                    <p className="mb-3 text-sm text-muted-foreground">{m.description}</p>
                    <Badge variant="secondary">
                      {m.features.length} feature{m.features.length === 1 ? "" : "s"} available
                    </Badge>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
