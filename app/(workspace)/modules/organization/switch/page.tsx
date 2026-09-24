import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { OrganizationSwitcher } from "@/components/organization/organization-switcher"

/**
 * Organization switcher page. Available to any authenticated user — the set of
 * organizations they can switch into is derived server-side from their live
 * memberships, so there is no additional permission gate here.
 */
export default async function OrganizationSwitchPage() {
  const session = await getSession()
  if (!session) redirect("/login")

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Switch organization</h1>
        <p className="text-sm text-muted-foreground">
          Choose which organization to work in. Your permissions and data are scoped to the active organization.
        </p>
      </header>
      <OrganizationSwitcher />
    </main>
  )
}
