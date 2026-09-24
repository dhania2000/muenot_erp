import type React from "react"
import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { getVendorResources } from "@/lib/vendor-portal/access"
import { getVendorDirectoryRow } from "@/lib/vendor-portal/store"
import { VendorPortalShell } from "@/components/vendor-portal/vendor-portal-shell"

export const dynamic = "force-dynamic"

export default async function VendorPortalLayout({ children }: { children: React.ReactNode }) {
  // The login route renders its own bare layout; detect it so we don't wrap it
  // in the authenticated shell.
  const hdrs = await headers()
  const pathname = hdrs.get("x-portal-pathname") ?? hdrs.get("x-pathname") ?? ""
  if (pathname.startsWith("/vendor-portal/login")) {
    return <>{children}</>
  }

  const session = await getVendorPortalSession()
  if (!session) redirect("/vendor-portal/login")

  const [resources, vendor] = await Promise.all([
    getVendorResources(session.tenantId, session.vendorId),
    getVendorDirectoryRow(session.vendorId).catch(() => null),
  ])

  return (
    <VendorPortalShell
      resources={resources}
      user={{ name: session.name, email: session.email }}
      vendorName={vendor?.name ?? null}
    >
      {children}
    </VendorPortalShell>
  )
}
