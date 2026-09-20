import { requireTenantAdmin } from "@/lib/platform-guard"
import { SecurityTabs } from "@/components/security/security-tabs"

export const dynamic = "force-dynamic"

// SPECS 56–66 — Security & Access shares one admin guard and one sub-nav for
// every screen in the cluster. Individual pages render only their own content.
export default async function SecurityLayout({ children }: { children: React.ReactNode }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>

  return (
    <main className="space-y-6 p-6">
      <SecurityTabs />
      {children}
    </main>
  )
}
