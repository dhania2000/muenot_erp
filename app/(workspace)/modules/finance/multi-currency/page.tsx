import { Coins } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function MultiCurrencyPage() {
  return (
    <SpecPage
      spec="SPEC 159"
      title="Multi-Currency"
      description="Transact in multiple currencies with exchange rates and revaluation support."
      icon={Coins}
      capabilities={["Currencies", "Exchange rates", "Rate history", "Revaluation", "Gain / loss", "Reporting currency"]}
      emptyTitle="No currencies configured"
      emptyDescription="Currencies and exchange rates will appear here."
    />
  )
}
