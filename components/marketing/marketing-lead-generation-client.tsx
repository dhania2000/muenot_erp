"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Target, Filter, FileText, Globe, Share2, Zap } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

const forms = [
  { name: "Homepage Newsletter", type: "Embedded form", views: 8420, leads: 612, rate: "7.3%", icon: Globe },
  { name: "Ebook Download", type: "Landing page", views: 5210, leads: 934, rate: "17.9%", icon: FileText },
  { name: "Demo Request", type: "Landing page", views: 3180, leads: 421, rate: "13.2%", icon: Zap },
  { name: "Social Contest", type: "Social capture", views: 6740, leads: 350, rate: "5.2%", icon: Share2 },
]

const funnel = [
  { stage: "Visitors", value: 23350, pct: 100 },
  { stage: "Engaged", value: 9820, pct: 42 },
  { stage: "Leads", value: 2317, pct: 24 },
  { stage: "Qualified", value: 894, pct: 39 },
  { stage: "Converted", value: 261, pct: 29 },
]

export function MarketingLeadGenerationClient() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Lead Generation"
        description="Capture forms, landing pages, and the conversion funnel that turns visitors into qualified leads."
        action={
          <Button>
            <Target className="size-4" />
            New Capture Form
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="New Leads" value="2,317" hint="This quarter" icon={Target} />
        <StatCard label="Conversion Rate" value="9.9%" hint="Visitor to lead" icon={Filter} />
        <StatCard label="Active Forms" value={forms.length} icon={FileText} />
        <StatCard label="Cost per Lead" value="$4.82" hint="-11% MoM" icon={Zap} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {forms.map((f) => (
            <Card key={f.name}>
              <CardContent className="flex flex-wrap items-center gap-4 pt-6">
                <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <f.icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{f.name}</div>
                  <div className="text-xs text-muted-foreground">{f.type}</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-semibold tabular-nums">{f.views.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Views</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-semibold tabular-nums">{f.leads}</div>
                  <div className="text-xs text-muted-foreground">Leads</div>
                </div>
                <Badge variant="secondary">{f.rate}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversion Funnel</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-2">
            {funnel.map((s) => (
              <div key={s.stage} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span>{s.stage}</span>
                  <span className="font-medium tabular-nums">{s.value.toLocaleString()}</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${s.pct}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
