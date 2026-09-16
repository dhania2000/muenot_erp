import { FinanceModuleClient } from "@/components/finance/finance-module-client"
import { RelatedPartiesTransactions } from "@/components/finance/related-parties-transactions"

export default function Page() {
  return (
    <div>
      <FinanceModuleClient moduleKey="related-parties" />
      <div className="space-y-8 px-6 pb-10">
        <RelatedPartiesTransactions />
      </div>
    </div>
  )
}
