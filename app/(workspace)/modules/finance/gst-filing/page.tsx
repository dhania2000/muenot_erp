import { GstFilingClient } from "@/components/finance/gst-filing-client"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab } = await searchParams
  return <GstFilingClient initialTab={tab} />
}
