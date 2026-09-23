import { Handshake } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function DealsPage() {
  return (
    <SpecPage
      spec="SPEC 115"
      title="Deals & Pipeline"
      description="Manage opportunities through a configurable sales pipeline with stages and probabilities."
      icon={Handshake}
      capabilities={["Pipeline stages", "Deal value", "Probability", "Kanban board", "Win / loss", "Forecast"]}
      emptyTitle="No deals"
      emptyDescription="Deals will appear here across your pipeline stages."
    />
  )
}
