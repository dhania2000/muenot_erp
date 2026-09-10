"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatCurrency, formatDate } from "@/lib/utils"
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
import { ContractDialog } from "@/components/sales/contract-dialog"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

export type ContractRow = {
  id: number
  contract_code: string
  contract_date: string | null
  company_name: string | null
  start_date: string | null
  end_date: string | null
  value: number
  contract_type: string | null
  status: string
  signed_by_client: string | null
  signed_by_company: string | null
  notes: string | null
  added_by_name: string | null
  created_at: string
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Draft: "outline",
  Active: "default",
  Expired: "secondary",
  Terminated: "destructive",
}

export function ContractsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ contracts: ContractRow[] }>("/api/sales/contracts", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ContractRow | null>(null)

  const contracts = data?.contracts ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return contracts
    return contracts.filter((v) =>
      [v.company_name, v.contract_code, v.contract_type].filter(Boolean).some((f) => f!.toLowerCase().includes(q)),
    )
  }, [contracts, search])

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/contracts/${id}`,
    labels: { singular: "contract", plural: "contracts" },
    mutate,
    onDeleted: clear,
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search contracts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-contracts" onImported={() => mutate()} />}
          <ExcelExportButton
            rows={filtered}
            filename="contracts"
            columns={[
              { header: "Contract Code", value: (r) => r.contract_code },
              { header: "Date", value: (r) => r.contract_date },
              { header: "Company", value: (r) => r.company_name },
              { header: "Start Date", value: (r) => r.start_date },
              { header: "End Date", value: (r) => r.end_date },
              { header: "Value", value: (r) => r.value },
              { header: "Type", value: (r) => r.contract_type },
              { header: "Status", value: (r) => r.status },
              { header: "Signed By Client", value: (r) => r.signed_by_client },
              { header: "Signed By Company", value: (r) => r.signed_by_company },
              { header: "Added By", value: (r) => r.added_by_name },
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
              Create contract
            </Button>
          )}
        </div>
      </div>

      {canManage && (
        <SelectionToolbar
          count={selected.size}
          noun="contract"
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
                  <SelectAllCheckbox ids={filtered.map((c) => c.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Contract</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Term</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading contracts...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No contracts found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((contract) => (
              <TableRow key={contract.id} data-state={selected.has(contract.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select contract ${contract.contract_code}`}
                      checked={selected.has(contract.id)}
                      onCheckedChange={() => toggle(contract.id)}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">{contract.contract_code}</TableCell>
                <TableCell>{contract.company_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(contract.start_date)} – {formatDate(contract.end_date)}
                </TableCell>
                <TableCell className="font-medium">{formatCurrency(contract.value)}</TableCell>
                <TableCell className="text-muted-foreground">{contract.contract_type || "—"}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[contract.status] || "outline"}>{contract.status}</Badge>
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(contract)
                            setDialogOpen(true)
                          }}
                        >
                          Edit contract
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => del.requestSingle(contract.id, `contract ${contract.contract_code}`)}
                        >
                          Delete contract
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

      <ContractDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contract={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Contract updated" : "Contract created")
          mutate()
        }}
      />

      {del.dialog}
    </div>
  )
}
