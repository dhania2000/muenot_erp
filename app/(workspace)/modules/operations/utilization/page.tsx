import { OperationsUtilizationAnalytics } from "@/components/operations/operations-utilization-analytics"

// SPEC 149 — Phase 3. Resource Utilization is a read-only analytics dashboard
// derived live from approved timesheets, resource capacity and allocations,
// not a generic CRUD table.
export default function UtilizationPage() {
  return <OperationsUtilizationAnalytics />
}
