"use client"

/**
 * Organization switcher.
 * ---------------------------------------------------------------------------
 * Lets a user who belongs to more than one organization change which tenant
 * their session is scoped to. The list of switch targets and the switch action
 * itself are BOTH validated server-side (`/api/organizations` +
 * `/api/organizations/switch`) against live membership — this component only
 * renders the result and never decides access on its own.
 *
 * After a successful switch the whole route tree is refreshed so every server
 * component re-reads data under the newly-scoped tenant.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Building2, Check, Crown, Home, Loader2 } from "lucide-react"

type Organization = {
  tenantId: number
  name: string
  slug: string
  tenantRole: string
  isPrimary: boolean
  isHome: boolean
  isActive: boolean
}

type OrganizationsResponse = {
  activeTenantId: number | null
  homeTenantId: number | null
  organizations: Organization[]
}

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  module_admin: "Module Admin",
  tenant_admin: "Administrator",
  tenant_owner: "Owner",
}

export function OrganizationSwitcher() {
  const router = useRouter()
  const { data, error, isLoading, mutate } = useSWR<OrganizationsResponse>("/api/organizations", fetcher)
  const [switchingTo, setSwitchingTo] = useState<number | null>(null)

  async function switchTo(org: Organization) {
    if (org.isActive || switchingTo != null) return
    setSwitchingTo(org.tenantId)
    try {
      const res = await fetch("/api/organizations/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: org.tenantId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not switch organization")
      toast.success(`Switched to ${org.name}`)
      await mutate()
      // Re-render every server component under the newly-scoped tenant.
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch organization")
    } finally {
      setSwitchingTo(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading organizations…
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error instanceof Error ? error.message : "Failed to load organizations"}
      </p>
    )
  }

  const organizations = data?.organizations ?? []

  if (organizations.length <= 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" aria-hidden="true" />
            {organizations[0]?.name ?? "Your organization"}
          </CardTitle>
          <CardDescription>
            You belong to a single organization. Membership in additional organizations will appear here.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <ul className="flex flex-col gap-3" aria-label="Your organizations">
      {organizations.map((org) => {
        const busy = switchingTo === org.tenantId
        return (
          <li key={org.tenantId}>
            <Card
              className={org.isActive ? "border-primary ring-1 ring-primary" : undefined}
              aria-current={org.isActive ? "true" : undefined}
            >
              <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Building2 className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{org.name}</span>
                      {org.isPrimary && (
                        <Badge variant="secondary" className="gap-1">
                          <Crown className="h-3 w-3" aria-hidden="true" />
                          Primary
                        </Badge>
                      )}
                      {org.isHome && (
                        <Badge variant="outline" className="gap-1">
                          <Home className="h-3 w-3" aria-hidden="true" />
                          Home
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {org.slug} · {ROLE_LABELS[org.tenantRole] ?? org.tenantRole}
                    </p>
                  </div>
                </div>
                {org.isActive ? (
                  <Badge className="gap-1">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Active
                  </Badge>
                ) : (
                  <Button size="sm" onClick={() => switchTo(org)} disabled={busy || switchingTo != null}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                    Switch
                  </Button>
                )}
              </CardContent>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
