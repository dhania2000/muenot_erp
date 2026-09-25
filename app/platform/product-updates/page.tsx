import { requirePlatformStaff } from "@/lib/platform-guard"
import { ProductUpdatesManager } from "@/components/product-updates/product-updates-manager"

export const dynamic = "force-dynamic"

export default async function ProductUpdatesPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Release notes</h1>
        <p className="text-sm text-muted-foreground text-pretty">
          Publish versioned product updates to everyone, specific roles, plans or tenants. Each user tracks their own read
          state within their tenant.
        </p>
      </header>
      <ProductUpdatesManager />
    </div>
  )
}
