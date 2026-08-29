import { redirect } from "next/navigation"
import { getAuthContext, visibleNav } from "@/lib/access"

export default async function HomePage() {
  const ctx = await getAuthContext()
  if (!ctx) redirect("/login")

  const nav = visibleNav(ctx.access)
  const first = nav[0]?.features[0]?.href
  if (first) redirect(first)

  // No access to anything yet.
  return (
    <div className="flex h-full items-center justify-center p-10 text-center">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold">Welcome to Muenot ERP</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You don&apos;t have access to any modules yet. Please contact your administrator to be granted access.
        </p>
      </div>
    </div>
  )
}
