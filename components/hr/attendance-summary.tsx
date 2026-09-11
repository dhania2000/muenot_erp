"use client"

export type AttendanceSummary = {
  totalEmployees: number
  records: number
  present: number
  absent: number
  onLeave: number
  late: number
  early: number
  halfDay: number
  missedCheckout: number
  overtime: number
  holidayOff: number
  regularisationPending: number
}

const CARDS: { key: keyof AttendanceSummary; label: string; tone: string }[] = [
  { key: "totalEmployees", label: "Employees", tone: "text-foreground" },
  { key: "present", label: "Present", tone: "text-emerald-500" },
  { key: "absent", label: "Absent", tone: "text-destructive" },
  { key: "onLeave", label: "On Leave", tone: "text-sky-500" },
  { key: "late", label: "Late", tone: "text-amber-500" },
  { key: "early", label: "Early Out", tone: "text-amber-500" },
  { key: "halfDay", label: "Half Day", tone: "text-orange-500" },
  { key: "missedCheckout", label: "Missed Checkout", tone: "text-destructive" },
  { key: "overtime", label: "Overtime", tone: "text-primary" },
  { key: "holidayOff", label: "Holiday / Off", tone: "text-muted-foreground" },
  { key: "regularisationPending", label: "Regularisation", tone: "text-amber-500" },
]

export function AttendanceSummaryCards({ summary }: { summary?: AttendanceSummary }) {
  return (
    <section
      aria-label="Attendance summary"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {CARDS.map((card) => (
        <div key={card.key} className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">{card.label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${card.tone}`}>
            {Number(summary?.[card.key] ?? 0)}
          </p>
        </div>
      ))}
    </section>
  )
}
