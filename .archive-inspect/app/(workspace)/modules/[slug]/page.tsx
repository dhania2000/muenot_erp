import { notFound, redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules } from "@/lib/permissions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2, CircleCheck } from "lucide-react"

const moduleIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
}

export default async function ModulePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const session = await getSession()
  if (!session) redirect("/login")

  const modules = await getUserAccessibleModules(session.userId, session.role)
  const currentModule = modules.find((m) => m.slug === slug)

  if (!currentModule) notFound()

  const Icon = moduleIcons[currentModule.slug] ?? Settings2

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{currentModule.name}</h1>
          <p className="text-sm text-muted-foreground">{currentModule.description}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {currentModule.features.map((f) => (
          <Card key={f.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
              <CardTitle className="text-base">{f.name}</CardTitle>
              <CircleCheck className="size-4 shrink-0 text-accent" />
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{f.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-dashed">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          This is your access preview for {currentModule.name}. The full {currentModule.name.toLowerCase()}{" "}
          workflows will be built out here next.
        </CardContent>
      </Card>
    </div>
  )
}
