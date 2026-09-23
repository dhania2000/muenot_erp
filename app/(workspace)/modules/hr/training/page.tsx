import { GraduationCap } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function TrainingPage() {
  return (
    <SpecPage
      spec="SPEC 131"
      title="Training Management"
      description="Plan, assign and track employee training programs, sessions and certifications."
      icon={GraduationCap}
      capabilities={["Programs", "Sessions", "Enrollment", "Attendance", "Assessments", "Certificates"]}
      emptyTitle="No training programs"
      emptyDescription="Training programs and enrollments will appear here."
    />
  )
}
