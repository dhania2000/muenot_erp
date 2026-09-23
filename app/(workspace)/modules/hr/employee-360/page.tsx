import { UserSquare } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function Employee360Page() {
  return (
    <SpecPage
      spec="SPEC 107"
      title="Employee 360"
      description="Unified view of every employee — profile, attendance, leave, payroll, assets, documents and history."
      icon={UserSquare}
      capabilities={["Profile", "Attendance", "Leave", "Payroll", "Assets", "Documents", "Performance", "Timeline"]}
      emptyTitle="No employee selected"
      emptyDescription="Select an employee to see their complete 360 profile here."
    />
  )
}
