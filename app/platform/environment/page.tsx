import Link from "next/link"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getEffectiveConfigByCategory } from "@/lib/config/service"
import { EnvironmentOverview } from "@/components/platform/environment-overview"

export const dynamic = "force-dynamic"

/**
 * Environment & configuration overview.
 * A read-only diagnostic of the EFFECTIVE configuration across all eight
 * categories, showing each value's source (env / store / default) with secrets
 * masked. Platform-staff surface; editing lives in the audited Configuration
 * and Feature flags pages.
 */
export default async function EnvironmentPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const groups = await getEffectiveConfigByCategory()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Environment &amp; configuration</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The effective configuration in use, resolved with precedence{" "}
          <span className="font-medium text-foreground">environment &rarr; store &rarr; default</span>. Platform and
          tenant scopes are shown separately, and secret values are always masked. Edit values in{" "}
          <Link href="/platform/config" className="font-medium text-primary hover:underline">
            Configuration
          </Link>{" "}
          or{" "}
          <Link href="/platform/feature-flags" className="font-medium text-primary hover:underline">
            Feature flags
          </Link>
          .
        </p>
      </header>

      <EnvironmentOverview groups={groups} />
    </div>
  )
}
