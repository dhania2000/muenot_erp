import { FinanceModuleClient } from "@/components/finance/finance-module-client"

// SPEC 143 — Budget Management. The config-driven module client renders the
// budget KPIs (budgeted / actual / net variance / over-budget count), the
// filterable list with per-row variance and approval badges, and the
// create/edit form driven by the "budgets" ModuleConfig.
export default function BudgetsPage() {
  return <FinanceModuleClient moduleKey="budgets" />
}
