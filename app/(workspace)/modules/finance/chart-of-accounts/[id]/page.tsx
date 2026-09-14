import { AccountDetailClient } from "@/components/finance/account-detail-client"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <AccountDetailClient accountId={id} />
}
