import { redirect } from "next/navigation"
import { getPortalSession } from "@/lib/portal/auth"
import { PortalLoginForm } from "@/components/portal/portal-login-form"

export const dynamic = "force-dynamic"

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>
}) {
  const session = await getPortalSession()
  if (session) redirect("/portal")
  const { redirect: redirectTo } = await searchParams

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-10">
      <PortalLoginForm redirect={redirectTo ?? "/portal"} />
    </main>
  )
}
