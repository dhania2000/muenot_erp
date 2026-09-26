/** SPEC 44 (#204) — pure project profitability math (revenue vs derived cost). */

export type ProfitabilityInput = {
  key: string
  label: string
  revenue: number
  cost: number
  budget: number
  progress: number | null
}

export type ProjectProfitabilityRow = {
  project_name: string
  revenue: number
  actual_cost: number
  gross_profit: number
  margin_percent: number
  budget_amount: number
  budget_used_percent: number | null
  progress_percent: number | null
  status: "Profitable" | "Low Margin" | "Loss" | "No Revenue"
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export const LOW_MARGIN_PERCENT = 10

export function computeProfitability(inputs: ProfitabilityInput[]): ProjectProfitabilityRow[] {
  const rows: ProjectProfitabilityRow[] = []
  for (const p of inputs) {
    const revenue = round2(p.revenue)
    const cost = round2(p.cost)
    if (revenue === 0 && cost === 0 && p.budget === 0) continue
    const profit = round2(revenue - cost)
    const margin = revenue > 0 ? round2((profit / revenue) * 100) : cost > 0 ? -100 : 0
    const status: ProjectProfitabilityRow["status"] =
      revenue === 0 ? "No Revenue" : profit < 0 ? "Loss" : margin < LOW_MARGIN_PERCENT ? "Low Margin" : "Profitable"
    rows.push({
      project_name: p.label,
      revenue,
      actual_cost: cost,
      gross_profit: profit,
      margin_percent: margin,
      budget_amount: round2(p.budget),
      budget_used_percent: p.budget > 0 ? round2((cost / p.budget) * 100) : null,
      progress_percent: p.progress,
      status,
    })
  }
  return rows.sort((a, b) => a.gross_profit - b.gross_profit)
}
