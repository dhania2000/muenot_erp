"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ArrowUpDownIcon, MoreHorizontal, Plus, Search } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { ContractDialog } from "@/components/sales/contract-dialog"
import { ContractDetailDrawer, CONTRACT_STATUS_STYLE } from "@/components/sales/contract-detail-drawer"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

export type ContractRow = {
  id: number
  contract_code: string
  title: string | null
  contract_date: string | null
  company_name: string | null
  start_date: string | null
  end_date: string | null
  value: number
  contract_type: string | null
  status: string
  esign_status: string
  signed_by_client: string | null
  signed_by_company: string | null
  terms: string | null
  notes: string | null
  auto_renew: number
  renewal_term_months: number | null
  notice_period_days: number | null
  relation: string
  version_no: number
  source_quotation_code: string | null
  row_version: number
  added_by_name: string | null
  created_at: string
}

type Analytics = {
  total: number
  active: number
  draft: number
  pending_signature: number
  expired: number
  terminated: number
  expiring_soon: number
  total_active_value: number
}

const STATUS_OPTIONS = [
  "all",
  "Draft",
  "Pending Signature",
  "Active",
  "Expired",
  "Terminated",
  "Cancelled",
  "Renewed",
]

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "created_at", label: "Created" },
  { value: "end_date", label: "End date" },
  { value: "value", label: "Value" },
  { value: "company_name", label: "Company" },
  { value: "status", label: "Status" },
]

export function ContractsClient({ canManage }: { canManage: boolean }) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [expiringOnly, setExpiringOnly] = useState(false)
  const [sort, setSort] = useState("created_at")
  const [dir, setDir] = useState<"asc" | "desc">("desc")

  const params = new URLSearchParams()
  if (search.trim()) params.set("search", search.trim())
  if (status !== "all") params.set("status", status)
  if (expiringOnly) params.set("expiring", "30")
  params.set("sort", sort)
  params.set("dir", dir)

  const { data, isLoading, mutate } = useSWR<{ contracts: ContractRow[]; analytics: Analytics }>(
    `/api/sales/contracts?${params.toString()}`,
    fetcher,
  )

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ContractRow | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const contracts = data?.contracts ?? []
  const a = data?.analytics

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/contracts/${id}`,
    labels: { singular: "contract", plural: "contracts" },
    mutate,
    onDeleted: clear,
  })

  const stats = useMemo(
    () => [
      { label: "Active", value: a?.active ?? 0, hint: a ? formatCurrency(a.total_active_value) : "" },
      { label: "Draft", value: a?.draft ?? 0 },
      { label: "Pending signature", value: a?.pending_signature ?? 0 },
      { label: "Expiring ≤30d", value: a?.expiring_soon ?? 0, accent: (a?.expiring_soon ?? 0) > 0 },
      { label: "Expired", value: a?.expired ?? 0 },
    ],
    [a],
  )

  function openDetail(id: number) {
    setDetailId(id)
    setDetailOpen(true)
  }

  function toggleSort(col: string) {
    if (sort === col) setDir(dir === "asc" ? "desc" : "asc")
    else {
      setSort(col)
      setDir("desc")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Analytics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-2xl font-semibold ${s.accent ? "text-amber-600 dark:text-amber-400" : ""}`}>
                {s.value}
              </p>
              {s.hint && <p className="text-xs text-muted-foreground">{s.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search contracts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 pl-8"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v ?? "all")}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "all" ? "All statuses" : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={expiringOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setExpiringOnly((v) => !v)}
          >
            Expiring soon
          </Button>
          <Select value={sort} onValueChange={(v) => setSort(v ?? "created_at")}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Toggle sort direction"
            onClick={() => setDir(dir === "asc" ? "desc" : "asc")}
          >
            <ArrowUpDownIcon className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-contracts" onImported={() => mutate()} />}
          <ExcelExportButton
            rows={contracts}
            filename="contracts"
            columns={[
              { header: "Contract Code", value: (r) => r.contract_code },
              { header: "Title", value: (r) => r.title },
              { header: "Date", value: (r) => r.contract_date },
              { header: "Company", value: (r) => r.company_name },
              { header: "Start Date", value: (r) => r.start_date },
              { header: "End Date", value: (r) => r.end_date },
              { header: "Value", value: (r) => r.value },
              { header: "Type", value: (r) => r.contract_type },
              { header: "Status", value: (r) => r.status },
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
                  <SelectAllCheckbox ids={contracts.map((c) => c.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Contract</TableHead>
              <TableHead>Company</TableHead>
              <SortableHead label="Term" col="end_date" sort={sort} dir={dir} onSort={toggleSort} />
              <SortableHead label="Value" col="value" sort={sort} dir={dir} onSort={toggleSort} />
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
            {!isLoading && contracts.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No contracts found.
                </TableCell>
              </TableRow>
            )}
            {contracts.map((contract) => (
              <TableRow
                key={contract.id}
                data-state={selected.has(contract.id) ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => openDetail(contract.id)}
              >
                {canManage && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select contract ${contract.contract_code}`}
                      checked={selected.has(contract.id)}
                      onCheckedChange={() => toggle(contract.id)}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  <div className="flex flex-col">
                    <span>{contract.contract_code}</span>
                    {contract.title && (
                      <span className="text-xs font-normal text-muted-foreground">{contract.title}</span>
                    )}
                    {contract.relation && contract.relation !== "Original" && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {contract.relation} · V{contract.version_no}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>{contract.company_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(contract.start_date)} – {formatDate(contract.end_date)}
                </TableCell>
                <TableCell className="font-medium">{formatCurrency(contract.value)}</TableCell>
                <TableCell className="text-muted-foreground">{contract.contract_type || "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={CONTRACT_STATUS_STYLE[contract.status] || ""}>
                    {contract.status}
                  </Badge>
                </TableCell>
                {canManage && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openDetail(contract.id)}>Open details</DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(contract)
                            setDialogOpen(true)
                          }}
                        >
                          Edit contract
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          render={
                            <a href={`/api/sales/contracts/${contract.id}/pdf`} target="_blank" rel="noreferrer" />
                          }
                        >
                          Download PDF
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {["Draft", "Cancelled"].includes(contract.status) ? (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => del.requestSingle(contract.id, `contract ${contract.contract_code}`)}
                          >
                            Delete contract
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={async () => {
                              const res = await fetch(`/api/sales/contracts/${contract.id}?mode=archive`, {
                                method: "DELETE",
                              })
                              if (res.ok) {
                                toast.success("Contract archived")
                                mutate()
                              } else {
                                const b = await res.json().catch(() => ({}))
                                toast.error(b.error || "Unable to archive")
                              }
                            }}
                          >
                            Archive contract
                          </DropdownMenuItem>
                        )}
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

      <ContractDetailDrawer
        id={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        canManage={canManage}
        onChanged={() => mutate()}
      />

      {del.dialog}
    </div>
  )
}

function SortableHead({
  label,
  col,
  sort,
  dir,
  onSort,
}: {
  label: string
  col: string
  sort: string
  dir: "asc" | "desc"
  onSort: (col: string) => void
}) {
  return (
    <TableHead>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(col)}
      >
        {label}
        <ArrowUpDownIcon className={`size-3 ${sort === col ? "text-foreground" : "text-muted-foreground/50"}`} />
      </button>
    </TableHead>
  )
}
