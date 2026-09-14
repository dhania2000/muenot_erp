import { BankAccountDetailClient } from "@/components/finance/bank-account-detail-client"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <BankAccountDetailClient accountId={id} />
}
