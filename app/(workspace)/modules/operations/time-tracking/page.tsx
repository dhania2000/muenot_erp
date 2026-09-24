import { OperationsTimeTrackingAnalytics } from "@/components/operations/operations-time-tracking-analytics"

// SPEC 148 — Phase 3. Time Tracking is a read-only analytics dashboard derived
// live from timesheets (project/client time, billable split, overtime, payroll),
// separate from the Timesheet Management CRUD screen used for data entry.
export default function TimeTrackingPage() {
  return <OperationsTimeTrackingAnalytics />
}
