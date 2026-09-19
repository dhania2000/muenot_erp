import { Cpu, Layers3 } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { SchedulerOverview } from "@/components/platform/scheduler-overview"

export const dynamic = "force-dynamic"

export default async function PlatformSchedulerPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <Cpu className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Central scheduler</h1>
          <p className="text-sm text-muted-foreground">One execution contract for reports, notifications, billing, sync and platform jobs.</p>
        </div>
      </header>
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground">
        <Layers3 className="mr-2 inline size-4" /> Every category is visible here. Empty categories are reserved extension slots so new payroll and AI workers can be added without changing the dispatcher.
      </div>
      <SchedulerOverview />
    </div>
  )
}
