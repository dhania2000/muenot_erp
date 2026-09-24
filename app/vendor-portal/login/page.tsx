import { redirect } from "next/navigation"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { VendorPortalLoginForm } from "@/components/vendor-portal/vendor-portal-login-form"

export const dynamic = "force-dynamic"

export default async function VendorPortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>
}) {
  const session = await getVendorPortalSession()
  if (session) redirect("/vendor-portal")
  const { redirect: redirectTo } = await searchParams

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-10">
      <VendorPortalLoginForm redirect={redirectTo ?? "/vendor-portal"} />
    </main>
  )
}
