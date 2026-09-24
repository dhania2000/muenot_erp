import { notFound, redirect } from "next/navigation"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { vendorCanAccess } from "@/lib/vendor-portal/access"
import { listItems, listMessages } from "@/lib/vendor-portal/store"
import { VENDOR_PORTAL_RESOURCE_META, isVendorPortalItemResource, isVendorPortalResource } from "@/lib/vendor-portal/config"
import { ItemList } from "@/components/vendor-portal/item-list"
import { InvoicesView } from "@/components/vendor-portal/invoices-view"
import { MessagesView } from "@/components/vendor-portal/messages-view"

export const dynamic = "force-dynamic"

export default async function VendorPortalResourcePage({ params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params
  if (!isVendorPortalResource(resource)) notFound()

  const session = await getVendorPortalSession()
  if (!session) redirect("/vendor-portal/login")

  // Fail-closed: the vendor must be explicitly granted this resource.
  if (!(await vendorCanAccess(session.tenantId, session.vendorId, resource))) notFound()

  const meta = VENDOR_PORTAL_RESOURCE_META[resource]

  if (resource === "messages") {
    const messages = await listMessages(session.tenantId, session.vendorId)
    return <MessagesView initialMessages={messages} />
  }

  if (isVendorPortalItemResource(resource)) {
    const items = await listItems(session.tenantId, session.vendorId, resource)
    if (resource === "invoices") return <InvoicesView items={items} />
    return <ItemList resource={resource} title={meta.labelPlural} description={meta.description} items={items} />
  }

  notFound()
}
