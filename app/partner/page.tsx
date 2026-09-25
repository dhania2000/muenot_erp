import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { PartnerDashboard } from "@/components/partners/partner-dashboard"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Partner dashboard", robots: { index: false } }

export default async function PartnerPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10">
      <PartnerDashboard />
    </main>
  )
}
