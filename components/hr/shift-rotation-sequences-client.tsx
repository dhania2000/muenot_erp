"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ExcelExportButton } from "@/components/excel-export-button"
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  Clock,
  Layers,
  Moon,
  Settings2,
} from "lucide-react"

type SequenceRecord = {
  sequence_id: string
  sequence_no: number
  order: number
  unit_span: number
  cycle_type: string
  span_label: string
  is_weekly_off: boolean
  label: string | null
  shift_id: number | null
  shift_code: string | null
  shift_name: string | null
  start_time: string | null
  end_time: string | null
  is_overnight: boolean
  shift_status: string | null
  invalid_shift: boolean
  inactive_shift: boolean
}

type Group = {
  rotation_id: string
  rotation_name: string
  status: string
  cycle_type: string
  cycle_length: number
  effective_from: string | null
  active_members: number
  version_no: number | null
  total_cycle_days: number
  declared_cycle_days: number
  consistent: boolean
  shifts_used: string[]
  warnings: string[]
  sequences: SequenceRecord[]
}

type ListResponse = {
  groups: Group[]
  flat: Record<string, unknown>[]
  rotationOptions: { rotation_id: string; rotation_name: string }[]
}

const ROTATIONS_HREF = "/modules/hr/shift-rotations"

function fmtTime(t: string | null): string {
  if (!t) return "—"
  return String(t).slice(0, 5)
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={status === "Active" ? "default" : "outline"} className="text-xs">
      {status}
    </Badge>
  )
}

export function ShiftRotationSequencesClient() {
  const [search, setSearch] = useState("")
  const [rotation, setRotation] = useState("all")
  const [cycleType, setCycleType] = useState("all")
  const [state, setState] = useState("all")
  const [detailId, setDetailId] = useState<string | null>(null)

  const params = new URLSearchParams()
  if (search.trim()) params.set("q", search.trim())
  if (rotation !== "all") params.set("rotation", rotation)
  if (cycleType !== "all") params.set("cycleType", cycleType)
  if (state !== "all") params.set("state", state)

  const { data, isLoading } = useSWR<ListResponse>(
    `/api/hr/shift-rotation-sequences?${params.toString()}`,
    fetcher,
  )

  const groups = data?.groups || []
  const exportRows = useMemo(() => data?.flat || [], [data])
  const totalSequences = groups.reduce((n, g) => n + g.sequences.length, 0)
  const rotationsWithIssues = groups.filter((g) => g.warnings.length > 0).length

  return (
    <main className="space-y-6 px-6">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">HR / Workforce / Shifts</p>
        <h1 className="text-3xl font-semibold tracking-tight">Shift Rotation Sequence</h1>
        <p className="text-muted-foreground">
          The ordered shift pattern inside each rotation. Sequences resolve an employee&apos;s shift for any
          date. Editing is done in the Rotation Builder so history and effective dates stay intact.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Rotations" value={groups.length} icon={<Layers className="size-4" />} />
        <SummaryCard label="Sequences" value={totalSequences} icon={<CalendarClock className="size-4" />} />
        <SummaryCard
          label="Need attention"
          value={rotationsWithIssues}
          icon={<AlertTriangle className="size-4" />}
          tone={rotationsWithIssues > 0 ? "warning" : "default"}
        />
        <Card className="flex items-center justify-between p-4">
          <div>
            <p className="text-sm text-muted-foreground">Edit sequences</p>
            <p className="text-sm font-medium">Rotation Builder</p>
          </div>
          <Button asChild size="sm" variant="secondary">
            <Link href={ROTATIONS_HREF}>
              Open <ArrowUpRight className="ml-1 size-4" />
            </Link>
          </Button>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search rotation, shift or sequence ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={rotation} onValueChange={setRotation}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Rotation" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rotations</SelectItem>
            {(data?.rotationOptions || []).map((r) => (
              <SelectItem key={r.rotation_id} value={r.rotation_id}>
                {r.rotation_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={cycleType} onValueChange={setCycleType}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Cycle type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All cycles</SelectItem>
            <SelectItem value="Days">Days</SelectItem>
            <SelectItem value="Weeks">Weeks</SelectItem>
            <SelectItem value="Months">Months</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={setState}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active only</SelectItem>
          </SelectContent>
        </Select>
        <ExcelExportButton
          rows={exportRows}
          filename="shift-rotation-sequences"
          columns={[
            { header: "Sequence ID", value: (r) => r.sequence_id },
            { header: "Rotation ID", value: (r) => r.rotation_id },
            { header: "Rotation Name", value: (r) => r.rotation_name },
            { header: "Sequence No", value: (r) => r.sequence_no },
            { header: "Shift", value: (r) => r.shift_name },
            { header: "Shift Code", value: (r) => r.shift_code },
            { header: "Duration", value: (r) => r.span },
            { header: "Cycle Type", value: (r) => r.cycle_type },
            { header: "Cycle Length", value: (r) => r.cycle_length },
            { header: "Status", value: (r) => r.status },
          ]}
        />
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading sequences…</p>
      ) : groups.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <RotationGroup key={g.rotation_id} group={g} onOpen={setDetailId} />
          ))}
        </div>
      )}

      <SequenceDetailDialog sequenceId={detailId} onClose={() => setDetailId(null)} />
    </main>
  )
}

function SummaryCard({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone?: "default" | "warning"
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{label}</p>
        <span className={tone === "warning" ? "text-amber-500" : "text-muted-foreground"}>{icon}</span>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  )
}

function RotationGroup({ group, onOpen }: { group: Group; onOpen: (id: string) => void }) {
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg">{group.rotation_name}</CardTitle>
            <StatusBadge status={group.status} />
            {group.version_no ? (
              <Badge variant="outline" className="text-xs">
                v{group.version_no}
              </Badge>
            ) : null}
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`${ROTATIONS_HREF}?rotation=${encodeURIComponent(group.rotation_id)}`}>
              <Settings2 className="mr-1 size-4" /> Manage in Builder
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{group.rotation_id}</span>
          <span>
            Cycle: {group.cycle_length} {group.cycle_type.toLowerCase()}
          </span>
          <span>
            Total cycle:{" "}
            <strong className="text-foreground tabular-nums">{group.total_cycle_days} days</strong>
          </span>
          {group.effective_from ? <span>Effective {group.effective_from}</span> : null}
          <span>{group.active_members} employee(s)</span>
          {group.shifts_used.length ? <span>Shifts: {group.shifts_used.join(", ")}</span> : null}
        </div>
        {!group.consistent && group.sequences.length > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="size-3.5" />
            Sequence total ({group.total_cycle_days}d) does not match the declared cycle (
            {group.declared_cycle_days}d).
          </p>
        ) : null}
        {group.warnings.map((w, i) => (
          <p key={i} className="flex items-center gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="size-3.5" /> {w}
          </p>
        ))}
      </CardHeader>
      <CardContent>
        {group.sequences.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">No rotation sequences configured.</p>
            <Button asChild size="sm" variant="secondary" className="mt-3">
              <Link href={`${ROTATIONS_HREF}?rotation=${encodeURIComponent(group.rotation_id)}`}>
                Add sequence in Builder
              </Link>
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Order</TableHead>
                <TableHead>Sequence</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Timing</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.sequences.map((s) => (
                <TableRow key={s.sequence_id}>
                  <TableCell className="font-medium tabular-nums">{s.order}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s.sequence_id}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className={s.is_weekly_off ? "text-muted-foreground" : ""}>
                        {s.shift_name || "—"}
                      </span>
                      {s.is_overnight ? <Moon className="size-3.5 text-muted-foreground" /> : null}
                      {s.inactive_shift ? (
                        <Badge variant="destructive" className="text-[10px]">
                          inactive
                        </Badge>
                      ) : null}
                      {s.invalid_shift ? (
                        <Badge variant="destructive" className="text-[10px]">
                          missing
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.is_weekly_off ? "—" : `${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`}
                  </TableCell>
                  <TableCell className="tabular-nums">{s.span_label}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => onOpen(s.sequence_id)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function EmptyState() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <Layers className="size-8 text-muted-foreground" />
      <div>
        <p className="font-medium">No rotation sequences configured.</p>
        <p className="text-sm text-muted-foreground">
          Sequences are defined as part of a rotation&apos;s pattern in the Rotation Builder.
        </p>
      </div>
      <Button asChild variant="secondary">
        <Link href={ROTATIONS_HREF}>Go to Shift Rotations</Link>
      </Button>
    </Card>
  )
}

type DetailResponse = {
  sequence: {
    sequence_id: string
    sequence_no: number
    unit_span: number
    is_weekly_off: boolean
    label: string | null
    rotation_id: string
    rotation_name: string
    version_no: number | null
    cycle_type: string
    cycle_length: number
    position_in_cycle: number
    total_steps: number
    total_cycle_days: number
    shift: {
      shift_id: number | null
      shift_code: string | null
      shift_name: string | null
      start_time: string | null
      end_time: string | null
      is_overnight: boolean
      break_minutes: number | null
      working_hours: number | null
      overtime_enabled: boolean
      status: string | null
    }
  }
  occurrences: { from: string; to: string }[]
}

function SequenceDetailDialog({
  sequenceId,
  onClose,
}: {
  sequenceId: string | null
  onClose: () => void
}) {
  const { data } = useSWR<DetailResponse>(
    sequenceId ? `/api/hr/shift-rotation-sequences?sequenceId=${encodeURIComponent(sequenceId)}` : null,
    fetcher,
  )

  return (
    <Dialog open={!!sequenceId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sequence detail</DialogTitle>
        </DialogHeader>
        {!data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Field label="Sequence ID" value={data.sequence.sequence_id} mono />
              <Field label="Rotation" value={`${data.sequence.rotation_name}`} />
              <Field
                label="Position in cycle"
                value={`${data.sequence.position_in_cycle} of ${data.sequence.total_steps}`}
              />
              <Field
                label="Duration"
                value={`${data.sequence.unit_span} ${data.sequence.cycle_type.toLowerCase()}`}
              />
              <Field
                label="Cycle"
                value={`${data.sequence.cycle_length} ${data.sequence.cycle_type.toLowerCase()} · ${data.sequence.total_cycle_days}d total`}
              />
              {data.sequence.version_no ? (
                <Field label="Version" value={`v${data.sequence.version_no}`} />
              ) : null}
            </div>

            <div className="rounded-md border p-3">
              <p className="mb-2 flex items-center gap-1.5 font-medium">
                <Clock className="size-4" />
                {data.sequence.is_weekly_off ? "Weekly Off" : data.sequence.shift.shift_name || "Shift"}
                {data.sequence.shift.is_overnight ? (
                  <Badge variant="outline" className="text-[10px]">
                    overnight
                  </Badge>
                ) : null}
                {data.sequence.shift.status &&
                data.sequence.shift.status.toLowerCase() === "inactive" ? (
                  <Badge variant="destructive" className="text-[10px]">
                    inactive
                  </Badge>
                ) : null}
              </p>
              {data.sequence.is_weekly_off ? (
                <p className="text-muted-foreground">This step is a scheduled weekly off.</p>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                  <span>Timing</span>
                  <span className="text-foreground">
                    {fmtTime(data.sequence.shift.start_time)}–{fmtTime(data.sequence.shift.end_time)}
                  </span>
                  <span>Working hours</span>
                  <span className="text-foreground">{data.sequence.shift.working_hours ?? "—"}</span>
                  <span>Break</span>
                  <span className="text-foreground">{data.sequence.shift.break_minutes ?? 0} min</span>
                  <span>Overtime</span>
                  <span className="text-foreground">
                    {data.sequence.shift.overtime_enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              )}
            </div>

            <div>
              <p className="mb-2 flex items-center gap-1.5 font-medium">
                <CalendarClock className="size-4" /> Upcoming occurrences
              </p>
              {data.occurrences.length === 0 ? (
                <p className="text-muted-foreground">No upcoming occurrences in the next year.</p>
              ) : (
                <ul className="space-y-1">
                  {data.occurrences.map((o, i) => (
                    <li key={i} className="flex justify-between rounded bg-muted/40 px-2 py-1">
                      <span className="tabular-nums">{o.from}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="tabular-nums">{o.to}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button asChild variant="secondary" className="w-full">
              <Link
                href={`${ROTATIONS_HREF}?rotation=${encodeURIComponent(data.sequence.rotation_id)}`}
              >
                <Settings2 className="mr-1 size-4" /> Edit in Rotation Builder
              </Link>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-xs" : ""}>{value}</p>
    </div>
  )
}
