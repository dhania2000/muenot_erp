import { requirePlatformStaff } from "@/lib/platform-guard"
import { listFeatureFlags } from "@/lib/platform-console"
import { FeatureFlagsManager } from "@/components/platform/feature-flags-manager"

export const dynamic = "force-dynamic"

export default async function FeatureFlagsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const flags = await listFeatureFlags()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Feature flags</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide feature rollout. Toggle a flag, adjust its rollout percentage, or create a new one.
        </p>
      </header>

      <FeatureFlagsManager flags={flags} />
    </div>
  )
}
