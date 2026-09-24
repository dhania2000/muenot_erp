"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Target, Plus, Pencil, Archive, ArchiveRestore, Trash2, LineChart } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { KpiFormDialog } from "./kpi-form-dialog"
import { KpiCheckinDialog } from "./kpi-checkin-dialog"
import type { KpiRollup } from "@/lib/goals-kpi/calc"
import {
  HEALTH_LABELS,
  KPI_SCOPES,
  PERIOD_LABELS,
  SCOPE_LABELS,
  type KpiGoalComputed,
  type KpiHealth,
} from "@/lib/goals-kpi/config"

type ApiResponse = {
  goals: KpiGoalComputed[]
  summary: KpiRollup
  byScope: Record<string, KpiRollup>
  canManage: boolean
}

const ALL = "__all__"

const HEALTH_BADGE: Record<KpiHealth, string> = {
  achieved: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  on_track: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  at_risk: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  behind: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
}

const HEALTH_BAR: Record<KpiHealth, string> = {
  achieved: "[&>[data-slot=progress-indicator]]:bg-emerald-500",
  on_track: "[&>[data-slot=progress-indicator]]:bg-sky-500",
  at_risk: "[&>[data-slot=progress-indicator]]:bg-amber-500",
  behind: "[&>[data-slot=progress-indicator]]:bg-rose-500",
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

export function GoalsKpiClient() {
  const [scope, setScope] = useState<string>(ALL)
  const [lifecycle, setLifecycle] = useState<"active" | "archived" | "all">("active")
  const [search, setSearch] = useState("")
  const [formOpen, setFormOpen] = useState(false)
  const [editGoal, setEditGoal] = useState<KpiGoalComputed | null>(null)
  const [checkinGoal, setCheckinGoal] = useState<KpiGoalComputed | null>(null)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    if (scope !== ALL) sp.set("scope", scope)
    sp.set("lifecycle", lifecycle)
    if (search.trim()) sp.set("q", search.trim())
    return sp.toString()
  }, [scope, lifecycle, search])

  const { data, mutate, isLoading } = useSWR<ApiResponse>(`/api/hr/goals-kpi?${queryString}`, fetcher)

  const goals = data?.goals ?? []
  const summary = data?.summary
  const byScope = data?.byScope ?? {}
  const canManage = data?.canManage ?? false

  function openCreate() {
    setEditGoal(null)
    setFormOpen(true)
  }
  function openEdit(goal: KpiGoalComputed) {
    setEditGoal(goal)
    setFormOpen(true)
  }

  async function toggleArchive(goal: KpiGoalComputed) {
    const next = goal.lifecycle === "archived" ? "active" : "archived"
    const res = await fetch(`/api/hr/goals-kpi/${goal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lifecycle: next }),
    })
    if (!res.ok) {
      toast.error("Update failed")
      return
    }
    toast.success(next === "archived" ? "KPI archived" : "KPI restored")
    mutate()
  }

  async function remove(goal: KpiGoalComputed) {
    if (!confirm(`Delete "${goal.name}"? This also removes its check-ins.`)) return
    const res = await fetch(`/api/hr/goals-kpi/${goal.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Delete failed")
      return
    }
    toast.success("KPI deleted")
    mutate()
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <Target className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 135</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Goals &amp; KPIs</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Configure individual, team, department, company and project KPIs with targets, actuals, weights and
              periods. Progress and health are computed automatically.
            </p>
          </div>
        </div>
        {canManage && (
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="size-4" />
            New KPI
          </Button>
        )}
      </header>

      <section aria-label="Summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="KPIs" value={String(summary?.count ?? 0)} hint={`${summary?.byHealth.achieved ?? 0} achieved`} />
        <StatCard
          label="Weighted score"
          value={`${summary?.weightedScore ?? 0}%`}
          hint={`total weight ${summary?.totalWeight ?? 0}`}
        />
        <StatCard label="Avg progress" value={`${summary?.averageProgress ?? 0}%`} />
        <StatCard
          label="At risk / behind"
          value={String((summary?.byHealth.at_risk ?? 0) + (summary?.byHealth.behind ?? 0))}
          hint={`${summary?.byHealth.on_track ?? 0} on track`}
        />
      </section>

      {Object.keys(byScope).length > 0 && (
        <section aria-label="By scope" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {KPI_SCOPES.filter((s) => byScope[s]).map((s) => {
            const r = byScope[s]
            return (
              <Card key={s}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span>{SCOPE_LABELS[s]}</span>
                    <span className="text-xs font-normal text-muted-foreground">{r.count}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <div className="text-xl font-semibold tabular-nums">{r.weightedScore}%</div>
                  <Progress value={r.weightedScore} className="h-1.5" />
                </CardContent>
              </Card>
            )
          })}
        </section>
      )}

      <section aria-label="Filters" className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search KPIs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All scopes</SelectItem>
            {KPI_SCOPES.map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs value={lifecycle} onValueChange={(v) => setLifecycle(v as typeof lifecycle)}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="archived">Archived</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </section>

      <section aria-label="KPIs" className="rounded-xl border bg-card">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading KPIs…</div>
        ) : goals.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LineChart />
              </EmptyMedia>
              <EmptyTitle>No KPIs yet</EmptyTitle>
              <EmptyDescription>
                {canManage
                  ? 'Create your first KPI with the "New KPI" button to start tracking progress.'
                  : "No KPIs have been defined for the selected filters."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>KPI</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="w-48">Progress</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {goals.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{g.name}</span>
                      <span className="text-xs text-muted-foreground">{PERIOD_LABELS[g.period_type]}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm">{SCOPE_LABELS[g.scope]}</span>
                      {g.scope_ref_label && (
                        <span className="text-xs text-muted-foreground">{g.scope_ref_label}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.target_value}
                    {g.unit ? ` ${g.unit}` : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.actual_value}
                    {g.unit ? ` ${g.unit}` : ""}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <Badge className={cn("text-[10px]", HEALTH_BADGE[g.health])} variant="outline">
                          {HEALTH_LABELS[g.health]}
                        </Badge>
                        <span className="text-xs font-medium tabular-nums">{g.progress}%</span>
                      </div>
                      <Progress value={g.progress} className={cn("h-1.5", HEALTH_BAR[g.health])} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{g.weight}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setCheckinGoal(g)}
                        aria-label="Check in progress"
                      >
                        <LineChart className="size-4" />
                      </Button>
                      {canManage && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => openEdit(g)}
                            aria-label="Edit KPI"
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => toggleArchive(g)}
                            aria-label={g.lifecycle === "archived" ? "Restore KPI" : "Archive KPI"}
                          >
                            {g.lifecycle === "archived" ? (
                              <ArchiveRestore className="size-4" />
                            ) : (
                              <Archive className="size-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            onClick={() => remove(g)}
                            aria-label="Delete KPI"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <KpiFormDialog open={formOpen} onOpenChange={setFormOpen} goal={editGoal} onSaved={() => mutate()} />
      <KpiCheckinDialog
        open={Boolean(checkinGoal)}
        onOpenChange={(o) => !o && setCheckinGoal(null)}
        goal={checkinGoal}
        canManage={canManage}
        onSaved={() => mutate()}
      />
    </div>
  )
}
