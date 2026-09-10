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
import { QuotationDialog } from "@/components/sales/quotation-dialog"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"

export type QuotationRow = {
  id: number
  quote_code: string
  quote_date: string | null
  company_name: string | null
  contact_person: string | null
  opportunity_name: string | null
  total_amount: number
  valid_until: string | null
  status: string
  added_by_name: string | null
  created_at: string
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Draft: "outline",
  Sent: "secondary",
  Accepted: "default",
  Rejected: "destructive",
  Expired: "destructive",
}

export function QuotationsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ quotations: QuotationRow[] }>("/api/sales/quotations", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<QuotationRow | null>(null)

  const quotations = data?.quotations ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return quotations
    return quotations.filter((v) =>
      [v.company_name, v.contact_person, v.opportunity_name, v.quote_code].filter(Boolean).some((f) =>
        f!.toLowerCase().includes(q),
      ),
    )
  }, [quotations, search])

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/quotations/${id}`,
    labels: { singular: "quotation", plural: "quotations" },
    mutate,
    onDeleted: clear,
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search quotations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-quotations" onImported={() => mutate()} />}
          <ExcelExportButton
            rows={filtered}
            filename="quotations"
            columns={[
              { header: "Quote Code", value: (r) => r.quote_code },
              { header: "Date", value: (r) => r.quote_date },
              { header: "Company", value: (r) => r.company_name },
              { header: "Contact Person", value: (r) => r.contact_person },
              { header: "Opportunity", value: (r) => r.opportunity_name },
              { header: "Amount", value: (r) => r.total_amount },
              { header: "Valid Until", value: (r) => r.valid_until },
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
              Create quotation
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
                  <SelectAllCheckbox ids={filtered.map((q) => q.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Quote</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Opportunity</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Valid until</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading quotations...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No quotations found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((quotation) => (
              <TableRow key={quotation.id} data-state={selected.has(quotation.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select quotation ${quotation.quote_code}`}
                      checked={selected.has(quotation.id)}
                      onCheckedChange={() => toggle(quotation.id)}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{quotation.quote_code}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(quotation.quote_date)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{quotation.company_name || "—"}</span>
                    <span className="text-xs text-muted-foreground">{quotation.contact_person || "—"}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{quotation.opportunity_name || "—"}</TableCell>
                <TableCell className="font-medium">{formatCurrency(quotation.total_amount)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(quotation.valid_until)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[quotation.status] || "outline"}>{quotation.status}</Badge>
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
                            setEditing(quotation)
                            setDialogOpen(true)
                          }}
                        >
                          Edit quotation
                        </DropdownMenuItem>
                        <DropdownMenuItem
                        variant="destructive"
                        onClick={() => del.requestSingle(quotation.id, `quotation ${quotation.quote_code}`)}
                      >
                          Delete quotation
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

      <QuotationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        quotation={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Quotation updated" : "Quotation created")
          mutate()
        }}
      />

      {del.dialog}
    </div>
  )
}
