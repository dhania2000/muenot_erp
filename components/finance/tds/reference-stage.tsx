"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Percent } from "lucide-react"
import { currency } from "./shared"

type Rule = {
  section: string
  nature: string
  entity_type: string | null
  rate: number
  rate_no_pan: number
  threshold_single: number | null
  threshold_annual: number | null
  effective_from: string | null
  active: boolean
}

/** Read-only view of the TDS Rule Master — the single table that drives every
 *  automatic rate, threshold and section pick across the module. */
export function ReferenceStage() {
  const { data } = useSWR<{ rules: Rule[] }>("/api/finance/tds/deductor", fetcher)
  const rules = data?.rules ?? []

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        The rule master is the single source of truth for TDS rates, section codes and thresholds. Every deduction
        across purchases, expenses, invoices and payroll is computed from these rows — including the section 206AA
        higher rate applied when a deductee has no valid PAN.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Percent className="h-4 w-4" />
            TDS rule master
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Section</TableHead>
                  <TableHead>Nature of payment</TableHead>
                  <TableHead>Applies to</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">No-PAN rate</TableHead>
                  <TableHead className="text-right">Threshold (single)</TableHead>
                  <TableHead className="text-right">Threshold (annual)</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                      No TDS rules configured.
                    </TableCell>
                  </TableRow>
                ) : (
                  rules.map((r, i) => (
                    <TableRow key={`${r.section}-${r.entity_type ?? ""}-${i}`}>
                      <TableCell className="font-medium">{r.section}</TableCell>
                      <TableCell>{r.nature}</TableCell>
                      <TableCell className="text-muted-foreground">{r.entity_type || "All"}</TableCell>
                      <TableCell className="text-right">{r.rate}%</TableCell>
                      <TableCell className="text-right font-medium">{r.rate_no_pan}%</TableCell>
                      <TableCell className="text-right">
                        {r.threshold_single ? currency(r.threshold_single) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.threshold_annual ? currency(r.threshold_annual) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.effective_from ? String(r.effective_from).slice(0, 10) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.active ? "default" : "outline"}>{r.active ? "Active" : "Inactive"}</Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
