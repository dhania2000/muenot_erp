"use client"

import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { inr0 } from "@/lib/finance-calc"

export type Direction = "receivable" | "payable" | "employee"
export type Quarter = "Q1" | "Q2" | "Q3" | "Q4"

export const currency = (n: any) => inr0(Number(n) || 0)
export const thisMonth = () => new Date().toISOString().slice(0, 7)

/** Current Indian financial year label, e.g. "2026-27". */
export function currentFy(): string {
  const d = new Date()
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** A handful of recent financial years for the FY picker. */
export function fyOptions(count = 6): string[] {
  const d = new Date()
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const y = startYear - i
    out.push(`${y}-${String((y + 1) % 100).padStart(2, "0")}`)
  }
  return out
}

export const QUARTERS: { value: Quarter; label: string }[] = [
  { value: "Q1", label: "Q1 · Apr–Jun" },
  { value: "Q2", label: "Q2 · Jul–Sep" },
  { value: "Q3", label: "Q3 · Oct–Dec" },
  { value: "Q4", label: "Q4 · Jan–Mar" },
]

export const isDeductor = (d: Direction) => d === "payable" || d === "employee"
export const returnForm = (d: Direction) => (d === "employee" ? "24Q" : "26Q")

export const DIRECTION_COPY: Record<Direction, { label: string; short: string; partyLabel: string }> = {
  receivable: { label: "TDS Receivable (Form 26AS)", short: "Receivable", partyLabel: "Customer" },
  payable: { label: "TDS Payable — Vendors (26Q)", short: "Payable", partyLabel: "Vendor" },
  employee: { label: "TDS Payable — Employees (24Q)", short: "Employee", partyLabel: "Payee" },
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Deposited: "default",
  Filed: "default",
  Issued: "default",
  Balanced: "default",
  Paid: "default",
  Matched: "default",
  Received: "default",
  Partial: "secondary",
  "Partially Received": "secondary",
  Credit: "secondary",
  Adjusted: "secondary",
  "Paid but Unallocated": "secondary",
  Pending: "destructive",
  Mismatch: "destructive",
  "Challan Mismatch": "destructive",
  "Return Mismatch": "destructive",
  "Certificate Mismatch": "destructive",
  Missing: "destructive",
  Outstanding: "destructive",
  Nil: "outline",
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{status}</Badge>
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}

export function StageHeading({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </div>
  )
}

export function FyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground" htmlFor="fy">
        Financial year
      </label>
      <select
        id="fy"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
      >
        {fyOptions().map((fy) => (
          <option key={fy} value={fy}>
            FY {fy}
          </option>
        ))}
      </select>
    </div>
  )
}
