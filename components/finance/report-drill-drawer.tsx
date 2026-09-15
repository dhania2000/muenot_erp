"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { inr } from "@/lib/finance-calc"
import { LedgerTraceDrawer } from "@/components/finance/ledger-trace-drawer"
import { Layers, Loader2Icon, ArrowRight } from "lucide-react"

type DrillLine = {
  ledgerId: string
  voucherNo: string
  date: string
  account: string
  group: string
  narration: string
  debit: number
  credit: number
  balance: number
  balanceType: string
  reconciliation: string
}

type DrillResponse = {
  account: string | null
  group: string | null
  available: boolean
  lines: DrillLine[]
  totals: { debit: number; credit: number }
}

export type DrillTarget = { account?: string; group?: string; label: string } | null

/**
 * Report → Account → Ledger drill. Opens the posted general_ledger movement for
 * the clicked account/group over the report's period, then hands each line off
 * to the existing LedgerTraceDrawer to continue Ledger → Journal → Source.
 */
export function ReportDrillDrawer({
  target,
  from,
  to,
  onClose,
}: {
  target: DrillTarget
  from: string
  to: string
  onClose: () => void
}) {
  const [voucher, setVoucher] = useState<string | null>(null)

  const params = new URLSearchParams()
  if (target?.account) params.set("account", target.account)
  if (target?.group) params.set("group", target.group)
  if (from) params.set("from", from)
  if (to) params.set("to", to)

  const { data, isLoading } = useSWR<DrillResponse>(
    target ? `/api/finance/reports/drill?${params.toString()}` : null,
    fetcher,
  )

  const lines = data?.lines ?? []

  return (
    <>
      <Sheet open={Boolean(target)} onOpenChange={(o) => (o ? null : onClose())}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-muted">
                <Layers className="size-3.5 text-muted-foreground" />
              </span>
              <SheetTitle className="text-sm">{target?.label}</SheetTitle>
              {data ? <Badge variant="secondary">{lines.length} ledger lines</Badge> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              General Ledger movement — select a line to trace Journal → Source.
            </p>
          </SheetHeader>

          {isLoading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading ledger…
            </div>
          ) : lines.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No posted ledger movement for this selection in the chosen period.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">Date</th>
                    <th className="p-2 font-medium">Voucher</th>
                    <th className="p-2 font-medium">Narration</th>
                    <th className="p-2 text-right font-medium">Debit</th>
                    <th className="p-2 text-right font-medium">Credit</th>
                    <th className="p-2 text-right font-medium">Balance</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr
                      key={l.ledgerId}
                      className={`border-t align-top ${l.voucherNo ? "cursor-pointer hover:bg-muted/50" : ""}`}
                      onClick={() => l.voucherNo && setVoucher(l.voucherNo)}
                    >
                      <td className="whitespace-nowrap p-2">{l.date || "—"}</td>
                      <td className="p-2 font-mono">{l.voucherNo || "—"}</td>
                      <td className="p-2 text-muted-foreground">{l.narration}</td>
                      <td className="p-2 text-right tabular-nums">{l.debit ? inr(l.debit) : "—"}</td>
                      <td className="p-2 text-right tabular-nums">{l.credit ? inr(l.credit) : "—"}</td>
                      <td className="whitespace-nowrap p-2 text-right tabular-nums">
                        {inr(Math.abs(l.balance))}
                        {l.balanceType ? (
                          <span className="ml-1 text-muted-foreground">
                            {l.balanceType === "Debit" ? "Dr" : "Cr"}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-right">
                        {l.voucherNo ? <ArrowRight className="size-3 text-muted-foreground" /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30 font-medium">
                    <td className="p-2" colSpan={3}>
                      Totals
                    </td>
                    <td className="p-2 text-right tabular-nums">{inr(data?.totals.debit || 0)}</td>
                    <td className="p-2 text-right tabular-nums">{inr(data?.totals.credit || 0)}</td>
                    <td className="p-2" colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <LedgerTraceDrawer voucherNo={voucher} onClose={() => setVoucher(null)} />
    </>
  )
}
