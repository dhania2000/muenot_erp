import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import {
  ClipboardList, Megaphone, Users, ListChecks, CalendarClock,
  ClipboardCheck, UserCheck, Network, Settings2, UserPlus, ChevronRight,
} from "lucide-react"

const FEATURES: { label: string; href: string; description: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { label: "Job Requisitions", href: "/modules/recruitment/job-requisitions", description: "Open positions, resource counts and hiring priorities.", icon: ClipboardList },
  { label: "Recruitment Campaigns", href: "/modules/recruitment/recruitment-campaigns", description: "Sourcing campaigns and their application funnel.", icon: Megaphone },
  { label: "Candidate Master", href: "/modules/recruitment/candidate-master", description: "Central candidate database across all requisitions.", icon: Users },
  { label: "Screening", href: "/modules/recruitment/screening", description: "Shortlisting scores and screening outcomes.", icon: ListChecks },
  { label: "Interview Tracker", href: "/modules/recruitment/interview-tracker", description: "Rounds, scores, feedback and interview results.", icon: CalendarClock },
  { label: "Assessment Tracker", href: "/modules/recruitment/assessment-tracker", description: "Assignments, scores and evaluation status.", icon: ClipboardCheck },
  { label: "Selection & Offers", href: "/modules/recruitment/selection-offers", description: "Offers, acceptance and joining status.", icon: UserCheck },
  { label: "Recruitment Sources", href: "/modules/recruitment/recruitment-sources", description: "Channel performance, cost and conversion.", icon: Network },
  { label: "Recruitment Settings", href: "/modules/recruitment/recruitment-settings", description: "Master lists and configuration values.", icon: Settings2 },
]

export default function RecruitmentDashboardPage() {
  return (
    <main className="space-y-8 p-6 md:p-8">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <UserPlus className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">Recruitment</h1>
          <p className="text-sm text-muted-foreground">Requisitions, candidates, interviews, offers and sourcing analytics.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon
          return (
            <Link key={f.href} href={f.href} className="group">
              <Card className="h-full transition-colors hover:border-primary/50 hover:bg-muted/40">
                <CardContent className="flex h-full flex-col gap-3 pt-6">
                  <div className="flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-4.5" />
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <div>
                    <h2 className="font-medium">{f.label}</h2>
                    <p className="mt-1 text-sm text-muted-foreground text-pretty">{f.description}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>
    </main>
  )
}
