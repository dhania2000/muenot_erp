"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Workflow, Plus, Mail, Clock, GitBranch, UserPlus, CheckCircle2 } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

type Step = { label: string; icon: React.ComponentType<{ className?: string }> }

const journeys: {
  name: string
  status: "Active" | "Draft" | "Paused"
  enrolled: number
  completion: string
  steps: Step[]
}[] = [
  {
    name: "Welcome Onboarding",
    status: "Active",
    enrolled: 1240,
    completion: "68%",
    steps: [
      { label: "Signup trigger", icon: UserPlus },
      { label: "Welcome email", icon: Mail },
      { label: "Wait 2 days", icon: Clock },
      { label: "Tips email", icon: Mail },
      { label: "Goal reached", icon: CheckCircle2 },
    ],
  },
  {
    name: "Lead Nurture",
    status: "Active",
    enrolled: 860,
    completion: "44%",
    steps: [
      { label: "Form submit", icon: UserPlus },
      { label: "Case study", icon: Mail },
      { label: "Branch: opened?", icon: GitBranch },
      { label: "Demo invite", icon: Mail },
    ],
  },
  {
    name: "Re-engagement",
    status: "Paused",
    enrolled: 420,
    completion: "21%",
    steps: [
      { label: "Inactive 30d", icon: Clock },
      { label: "We miss you", icon: Mail },
      { label: "Offer email", icon: Mail },
    ],
  },
  {
    name: "Cart Recovery",
    status: "Draft",
    enrolled: 0,
    completion: "—",
    steps: [
      { label: "Cart abandoned", icon: Clock },
      { label: "Reminder", icon: Mail },
      { label: "Discount", icon: Mail },
    ],
  },
]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Active: "default",
  Paused: "secondary",
  Draft: "outline",
}

export function MarketingJourneysClient() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Journeys"
        description="Automated, multi-step customer journeys that trigger on behaviour and guide contacts toward a goal."
        action={
          <Button>
            <Plus className="size-4" />
            New Journey
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Active Journeys" value={journeys.filter((j) => j.status === "Active").length} icon={Workflow} />
        <StatCard label="Contacts Enrolled" value="2,520" icon={UserPlus} />
        <StatCard label="Avg. Completion" value="53%" icon={CheckCircle2} />
      </div>

      <div className="flex flex-col gap-4">
        {journeys.map((j) => (
          <Card key={j.name}>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">{j.name}</CardTitle>
              <Badge variant={STATUS_VARIANT[j.status]}>{j.status}</Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {j.steps.map((s, i) => (
                  <div key={s.label} className="flex items-center gap-2">
                    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
                      <s.icon className="size-3.5 text-primary" />
                      <span className="text-xs">{s.label}</span>
                    </div>
                    {i < j.steps.length - 1 && <span className="text-muted-foreground">&rarr;</span>}
                  </div>
                ))}
              </div>
              <div className="flex gap-6 text-sm text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground tabular-nums">{j.enrolled.toLocaleString()}</span> enrolled
                </span>
                <span>
                  <span className="font-medium text-foreground">{j.completion}</span> completion
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  )
}
