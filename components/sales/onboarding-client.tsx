"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, Search } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { OnboardingDialog } from "@/components/sales/onboarding-dialog"
import { OnboardingDetailDrawer } from "@/components/sales/onboarding-detail-drawer"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"
import {
  ONBOARDING_STAGES,
  ONBOARDING_STATUSES,
  ONBOARDING_HEALTH,
  STATUS_VARIANT,
  HEALTH_VARIANT,
} from "@/components/sales/onboarding-constants"

export type OnboardingRow = {
  id: number
  onboarding_code: string
  onboarding_date: string | null
  company_name: string | null
  company_id: number | null
  contact_id: number | null
  contact_person: string | null
  contract_id: number | null
  contract_code: string | null
  quotation_id: number | null
  lead_id: number | null
  owner_id: number | null
  owner_name: string | null
  current_stage: string
  status: string
  health: string
  progress_pct: number | null
  priority: string | null
  start_date: string | null
  target_completion_date: string | null
  kickoff_meeting_date: string | null
  kickoff_meeting_id: number | null
  requirements_summary: string | null
  scope_notes: string | null
  internal_notes: string | null
  added_by_name: string | null
  row_version: number
  archived_at: string | null
  created_at: string
}

const ALL = "__all"

export function OnboardingClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ onboarding: OnboardingRow[] }>("/api/sales/onboarding", fetcher)
  const { data: analyticsData } = useSWR<{ analytics: any }>("/api/sales/onboarding/analytics", fetcher)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [stageFilter, setStageFilter] = useState<string>(ALL)
  const [healthFilter, setHealthFilter] = useState<string>(ALL)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<OnboardingRow | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)

  const records = data?.onboarding ?? []
  const analytics = analyticsData?.analytics

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return records.filter((v) => {
      if (statusFilter !== ALL && v.status !== statusFilter) return false
      if (stageFilter !== ALL && v.current_stage !== stageFilter) return false
      if (healthFilter !== ALL && v.health !== healthFilter) return false
      if (
        q &&
        ![v.company_name, v.onboarding_code, v.contract_code, v.owner_name, v.contact_person]
          .filter(Boolean)
          .some((f) => f!.toLowerCase().includes(q))
      )
        return false
      return true
    })
  }, [records, search, statusFilter, stageFilter, healthFilter])

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/onboarding/${id}`,
    labels: { singular: "onboarding record", plural: "onboarding records" },
    mutate,
    onDeleted: clear,
  })

  return (
    <div className="flex flex-col gap-4">
      {analytics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label="Active" value={analytics.totals?.active ?? 0} />
          <SummaryCard label="Completed" value={analytics.totals?.completed ?? 0} />
          <SummaryCard label="Avg progress" value={`${analytics.totals?.avg_progress ?? 0}%`} />
          <SummaryCard label="Overdue" value={analytics.overdue ?? 0} tone={analytics.overdue ? "warn" : undefined} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search onboarding..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 pl-8"
            />
          </div>
          <FilterSelect value={statusFilter} onChange={setStatusFilter} placeholder="All statuses" options={ONBOARDING_STATUSES} />
          <FilterSelect value={stageFilter} onChange={setStageFilter} placeholder="All stages" options={ONBOARDING_STAGES} />
          <FilterSelect value={healthFilter} onChange={setHealthFilter} placeholder="All health" options={ONBOARDING_HEALTH} />
        </div>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-onboarding" onImported={() => mutate()} />}
          <ExcelExportButton
            rows={filtered}
            filename="onboarding"
            columns={[
              { header: "Onboarding Code", value: (r) => r.onboarding_code },
              { header: "Date", value: (r) => r.onboarding_date },
              { header: "Company", value: (r) => r.company_name },
              { header: "Contract", value: (r) => r.contract_code },
              { header: "Stage", value: (r) => r.current_stage },
              { header: "Status", value: (r) => r.status },
              { header: "Health", value: (r) => r.health },
              { header: "Progress", value: (r) => `${r.progress_pct ?? 0}%` },
              { header: "Owner", value: (r) => r.owner_name },
              { header: "Target Completion", value: (r) => r.target_completion_date },
            ]}
          />
          {canManage && (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus data-icon="inline-start" />
              Add onboarding
            </Button>
          )}
        </div>
      </div>

      {canManage && selected.size > 0 && (
        <SelectionToolbar
          count={selected.size}
          noun="onboarding"
          onClear={clear}
          onDelete={() => del.requestBulk([...selected])}
        />
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {canManage && (
                <TableHead className="w-10">
                  <SelectAllCheckbox ids={filtered.map((r) => r.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Company</TableHead>
              <TableHead>Contract</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="w-40">Progress</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Target</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  Loading onboarding records...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  No onboarding records found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((record) => (
              <TableRow
                key={record.id}
                data-state={selected.has(record.id) ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => setDetailId(record.id)}
              >
                {canManage && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select onboarding record ${record.onboarding_code}`}
                      checked={selected.has(record.id)}
                      onCheckedChange={() => toggle(record.id)}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{record.company_name || "—"}</span>
                    <span className="text-xs text-muted-foreground">{record.onboarding_code}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{record.contract_code || "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{record.current_stage}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, record.progress_pct ?? 0))}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">{record.progress_pct ?? 0}%</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={HEALTH_VARIANT[record.health] || "outline"}>{record.health || "—"}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[record.status] || "outline"}>{record.status}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{record.owner_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(record.target_completion_date)}</TableCell>
                {canManage && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setDetailId(record.id)}>Open</DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(record)
                            setDialogOpen(true)
                          }}
                        >
                          Edit record
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => del.requestSingle(record.id, `onboarding record ${record.onboarding_code}`)}
                        >
                          {record.archived_at ? "Delete permanently" : "Archive"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <OnboardingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        record={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Onboarding record updated" : "Onboarding record added")
          mutate()
        }}
      />

      <OnboardingDetailDrawer
        onboardingId={detailId}
        open={detailId !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        canManage={canManage}
        onChanged={() => mutate()}
      />

      {del.dialog}
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={tone === "warn" ? "text-2xl font-semibold text-amber-600" : "text-2xl font-semibold"}>{value}</p>
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: readonly string[]
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "__all")}>
      <SelectTrigger size="sm" className="w-36">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="__all">{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
