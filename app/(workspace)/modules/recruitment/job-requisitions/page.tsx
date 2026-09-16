import { redirect } from "next/navigation"

// Unified flow: "Job Requisitions" and "Requisition & Hiring" used to be two
// parallel pipelines writing the same recruitment_requisitions table, but the
// generic config-driven Job Requisitions page bypassed the approval workflow.
// requisition-hiring is now canonical (approval + job creation + headcount
// auto-calc), so this route permanently redirects onto it. All existing
// requisition data still shows there since both read the same table.
export default function Page() {
  redirect("/modules/recruitment/requisition-hiring")
}
