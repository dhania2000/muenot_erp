"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { TenantHealthDetail } from "@/lib/customer-success/store"
import type { HealthBand } from "@/lib/customer-success/model"
import { cn } from "@/lib/utils"

export const BAND_LABEL: Record<HealthBand, string> = { healthy: "Healthy", watch: "Watch", at_risk: "At risk" }
export const BAND_CLASS: Record<HealthBand, string> = {
  healthy: "bg-emerald-600 text-white hover:bg-emerald-600",
  watch: "bg-amber-500 text-white hover:bg-amber-500",
  at_risk: "bg-red-600 text-white hover:bg-red-600",
}

export function BandBadge({ band }: { band: HealthBand | null }) {
  if (!band) return <Badge variant="outline">Not scored</Badge>
  return <Badge className={BAND_CLASS[band]}>{BAND_LABEL[band]}</Badge>
}

function Sparkline({ points }: { points: { date: string; score: number }[] }) {
  if (points.length < 2) return <p className="text-sm text-muted-foreground">Trend appears after two or more daily snapshots.</p>
  const w = 320
  const h = 64
  const step = w / (points.length - 1)
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (p.score / 100) * h).toFixed(1)}`).join(" ")
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full text-primary" role="img" aria-label={`Health score trend from ${points[0].score} to ${points[points.length - 1].score}`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  )
}

export function HealthDetail({ data }: { data: TenantHealthDetail }) {
  const { snapshot, trend, modules, settings } = data
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Health score</CardDescription>
            <CardTitle className="flex items-center gap-3 text-4xl">
              {snapshot.score}
              <BandBadge band={snapshot.band} />
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Snapshot {snapshot.date}</CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardDescription>Trend ({trend.points.length} days)</CardDescription>
            <CardTitle className="text-base">
              {trend.direction === "flat" ? "Stable" : trend.direction === "up" ? `Improving +${trend.delta}` : `Declining ${trend.delta}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Sparkline points={trend.points} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Why this score</CardTitle>
          <CardDescription>Each factor is scored 0-100 and weighted. Contributions add up to the overall score.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {snapshot.factors.map((f) => (
            <div key={f.key} className={cn("flex flex-col gap-1", !f.available && "opacity-60")}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{f.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {f.available ? `${f.score}/100 × ${f.effectiveWeight}% = ${f.contribution} pts` : "Excluded"}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full bg-primary" style={{ width: `${f.available ? f.score : 0}%` }} />
              </div>
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {f.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Churn-risk factors</CardTitle>
            <CardDescription>Aggregated counts only; no personal or record content.</CardDescription>
          </CardHeader>
          <CardContent>
            {snapshot.risks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No churn-risk factors detected.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {snapshot.risks.map((r) => (
                  <li key={r.key} className="flex items-start gap-2 text-sm">
                    <Badge variant={r.severity === "high" ? "destructive" : "secondary"}>{r.severity}</Badge>
                    <span>{r.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Module usage (30 days)</CardTitle>
            <CardDescription>
              {settings.analyticsOptOut ? "Usage analytics are disabled for this tenant." : `Raw events retained ${settings.retentionDays} days.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {modules.length === 0 ? (
              <p className="text-sm text-muted-foreground">No usage recorded.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-1 font-medium">Module</th>
                    <th className="pb-1 font-medium">Feature</th>
                    <th className="pb-1 text-right font-medium">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {modules.map((m) => (
                    <tr key={`${m.module}-${m.feature}`} className="border-t">
                      <td className="py-1">{m.module}</td>
                      <td className="py-1 text-muted-foreground">{m.feature}</td>
                      <td className="py-1 text-right tabular-nums">{m.events}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
