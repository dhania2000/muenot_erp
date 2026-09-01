import { notFound, redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules } from "@/lib/permissions"
import { WorkspaceModuleClient } from "@/components/workspace-module-client"
import { MessagesClient } from "@/components/messages-client"
import { CalendarDays, FileText, Link2, MessageSquare, Monitor, Newspaper, Package, ScanFace, Users2, TrendingUp, Wallet, UserPlus, Settings2, Ticket } from "lucide-react"

const moduleIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
  calendar: CalendarDays, events: Ticket, messages: MessageSquare, "notice-board": Newspaper, "knowledge-base": FileText,
  assets: Package, biolinks: Link2, biometric: ScanFace, letter: FileText, "monitor-center": Monitor,
}

export default async function ModulePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const session = await getSession()
  if (!session) redirect("/login")

  const modules = await getUserAccessibleModules(session.userId, session.role)
  const currentModule = modules.find((m) => m.slug === slug)

  if (!currentModule) notFound()

  const Icon = moduleIcons[currentModule.slug] ?? Settings2

  if (slug === "messages") return <MessagesClient />
  if (["calendar", "events", "notice-board", "knowledge-base", "assets", "biolinks", "biometric", "letter", "monitor-center"].includes(slug)) {
    return <WorkspaceModuleClient slug={slug} name={currentModule.name ?? slug} description={currentModule.description ?? "Workspace module"} />
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="size-5" /></div><div><h1 className="text-2xl font-semibold tracking-tight">{currentModule.name}</h1><p className="text-sm text-muted-foreground">{currentModule.description}</p></div></div>
      <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">Select a feature from the sidebar to get started.</div>
    </div>
  )
}
