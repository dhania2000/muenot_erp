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
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

export type OnboardingRow = {
  id: number
  onboarding_code: string
  onboarding_date: string | null
  company_name: string | null
  contract_code: string | null
  start_date: string | null
  kickoff_meeting_date: string | null
  current_stage: string
  status: string
  onboarding_by: string | null
  added_by_name: string | null
  created_at: string
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  "Not Started": "outline",
  "In Progress": "secondary",
  Completed: "default",
  "On Hold": "destructive",
}

export function OnboardingClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ onboarding: OnboardingRow[] }>("/api/sales/onboarding", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<OnboardingRow | null>(null)

  const records = data?.onboarding ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return records
    return records.filter((v) =>
      [v.company_name, v.onboarding_code, v.contract_code, v.onboarding_by].filter(Boolean).some((f) =>
        f!.toLowerCase().includes(q),
      ),
    )
  }, [records, search])

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/onboarding/${id}`,
    labels: { singular: "onboarding record", plural: "onboarding records" },
    mutate,
    onDeleted: clear,
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search onboarding..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
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
              { header: "Start Date", value: (r) => r.start_date },
              { header: "Kickoff Date", value: (r) => r.kickoff_meeting_date },
              { header: "Stage", value: (r) => r.current_stage },
              { header: "Status", value: (r) => r.status },
              { header: "Owner", value: (r) => r.onboarding_by },
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
              <TableHead>Kickoff</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Owner</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading onboarding records...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No onboarding records found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((record) => (
              <TableRow key={record.id} data-state={selected.has(record.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
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
                <TableCell className="text-muted-foreground">{formatDate(record.kickoff_meeting_date)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{record.current_stage}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[record.status] || "outline"}>{record.status}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{record.onboarding_by || "—"}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
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
                          Delete record
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

      {del.dialog}
    </div>
  )
}
