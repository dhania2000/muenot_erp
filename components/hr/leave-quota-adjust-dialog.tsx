"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"

const currentYear = new Date().getFullYear()

type Preset = { employee_id?: string; leave_type_id?: string; year?: number } | null

/**
 * Controlled manual adjustment. This is the only manual write into the ledger:
 * it posts a signed adjustment (via the balances engine) which mints an LADJ
 * reference and an immutable quota-history row — users never type ids, signs,
 * references or the system source.
 */
export function LeaveQuotaAdjustDialog({
  open,
  onOpenChange,
  onApplied,
  preset,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onApplied: () => void
  preset?: Preset
}) {
  const { data } = useSWR<any>(open ? "/api/hr/leave-quota-history/context" : null, fetcher)
  const employees: any[] = data?.employees || []
  const leaveTypes: any[] = data?.leaveTypes || []
  const years: number[] = data?.years?.length ? data.years : [currentYear]

  const [employeeId, setEmployeeId] = useState("")
  const [leaveTypeId, setLeaveTypeId] = useState("")
  const [year, setYear] = useState(String(currentYear))
  const [direction, setDirection] = useState<"credit" | "debit">("credit")
  const [days, setDays] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setEmployeeId(preset?.employee_id ? String(preset.employee_id) : "")
      setLeaveTypeId(preset?.leave_type_id ? String(preset.leave_type_id) : "")
      setYear(String(preset?.year || currentYear))
      setDirection("credit")
      setDays("")
      setReason("")
    }
  }, [open, preset])

  async function submit() {
    if (!employeeId || !leaveTypeId || !year) {
      toast.error("Select an employee, leave type and year.")
      return
    }
    const amount = Number(days)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a positive number of days.")
      return
    }
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/hr/leave-quota-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          employee_id: Number(employeeId),
          leave_type_id: leaveTypeId,
          year: Number(year),
          direction,
          days: amount,
          reason: reason.trim(),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Could not apply the adjustment.")
        return
      }
      toast.success(`Adjustment posted (${json.adjustment_id}).`)
      onApplied()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New quota adjustment</DialogTitle>
          <DialogDescription>
            Post a controlled credit or debit. The system generates the reference (LADJ), records the actor and
            writes an immutable ledger entry — history is never edited in place.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="adj-employee">Employee</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger id="adj-employee">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.employee_name} · {e.employee_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="adj-type">Leave type</Label>
              <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
                <SelectTrigger id="adj-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {leaveTypes.map((t) => (
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
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
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
              <Label htmlFor="adj-days">Days</Label>
              <Input
                id="adj-days"
                type="number"
                min="0"
                step="0.5"
                value={days}
                onChange={(e) => setDays(e.target.value)}
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
              placeholder="Why is this adjustment being made?"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Posting…" : "Post adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
