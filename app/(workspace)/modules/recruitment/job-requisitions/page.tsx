import { RecruitmentModuleClient } from "@/components/recruitment/recruitment-module-client"

// "Job Requisitions" renders its own config-driven requisition register.
// It reads the same recruitment_requisitions table as "Requisition Hiring",
// so data stays in sync; that page remains the canonical approval + hiring flow.
export default function Page() {
  return <RecruitmentModuleClient moduleKey="job-requisitions" />
}
