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
import { ContractDialog } from "@/components/sales/contract-dialog"

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

  async function deleteContract(contract: ContractRow) {
    if (!confirm(`Delete contract ${contract.contract_code}?`)) return
    const res = await fetch(`/api/sales/contracts/${contract.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Contract deleted")
      mutate()
    } else {
      toast.error("Unable to delete contract")
    }
  }

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

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
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
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Loading contracts...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No contracts found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((contract) => (
              <TableRow key={contract.id}>
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
                        <DropdownMenuItem variant="destructive" onClick={() => deleteContract(contract)}>
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
    </div>
  )
}
