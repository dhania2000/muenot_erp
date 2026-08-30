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
import { OnboardingDialog } from "@/components/sales/onboarding-dialog"

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

  async function deleteRecord(record: OnboardingRow) {
    if (!confirm(`Delete onboarding record ${record.onboarding_code}?`)) return
    const res = await fetch(`/api/sales/onboarding/${record.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Onboarding record deleted")
      mutate()
    } else {
      toast.error("Unable to delete onboarding record")
    }
  }

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

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
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
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Loading onboarding records...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No onboarding records found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((record) => (
              <TableRow key={record.id}>
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
                        <DropdownMenuItem variant="destructive" onClick={() => deleteRecord(record)}>
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
    </div>
  )
}
