import { InvestmentDetailClient } from "@/components/finance/investment-detail-client"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <InvestmentDetailClient investmentId={id} />
}
