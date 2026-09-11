"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"

type Preset = { employee_id?: string; leave_type_id?: string; year?: number }

export function LeaveBalanceAdjustDialog({
  open,
  onOpenChange,
  onApplied,
  preset,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onApplied: () => void
  preset?: Preset | null
}) {
  const { data } = useSWR<any>(open ? "/api/hr/leave-balances/context" : null, fetcher)
  const employees = data?.employees || []
  const leaveTypes = data?.leaveTypes || []
  const years: number[] = data?.years || [new Date().getFullYear()]

  const [employeeId, setEmployeeId] = useState("")
  const [leaveTypeId, setLeaveTypeId] = useState("")
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [direction, setDirection] = useState<"credit" | "debit">("credit")
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && preset) {
      if (preset.employee_id) setEmployeeId(String(preset.employee_id))
      if (preset.leave_type_id) setLeaveTypeId(String(preset.leave_type_id))
      if (preset.year) setYear(String(preset.year))
    }
  }, [open, preset])

  function reset() {
    setEmployeeId("")
    setLeaveTypeId("")
    setYear(String(new Date().getFullYear()))
    setDirection("credit")
    setAmount("")
    setReason("")
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const magnitude = Math.abs(Number(amount))
    if (!employeeId || !leaveTypeId || !year) {
      toast.error("Select an employee, leave type and year.")
      return
    }
    if (!magnitude || Number.isNaN(magnitude)) {
      toast.error("Enter a number of days to adjust.")
      return
    }
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    const days = direction === "debit" ? -magnitude : magnitude
    setBusy(true)
    try {
      const res = await fetch("/api/hr/leave-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employee_id: employeeId, leave_type_id: leaveTypeId, year: Number(year), days, reason }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Adjustment failed.")
        return
      }
      toast.success(`Adjustment ${json.adjustment_id} applied.`)
      reset()
      onOpenChange(false)
      onApplied()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Adjust leave balance</DialogTitle>
          <DialogDescription>
            Adjustments are recorded as traceable transactions — they never edit the calculated available balance directly.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="adj-employee">Employee</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger id="adj-employee">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.employee_name} · {e.employee_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="adj-type">Leave type</Label>
              <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
                <SelectTrigger id="adj-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {leaveTypes.map((t: any) => (
                    <SelectItem key={t.leave_type_id} value={t.leave_type_id}>
                      {t.leave_type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="adj-year">Year</Label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger id="adj-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="adj-direction">Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as "credit" | "debit")}>
                <SelectTrigger id="adj-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Credit (+ add days)</SelectItem>
                  <SelectItem value="debit">Debit (− remove days)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="adj-amount">Days</Label>
              <Input
                id="adj-amount"
                type="number"
                min="0"
                step="0.5"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 2"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="adj-reason">Reason</Label>
            <Textarea
              id="adj-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Management approved additional leave"
              rows={2}
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { reset(); onOpenChange(false) }}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Applying…" : "Submit adjustment"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
