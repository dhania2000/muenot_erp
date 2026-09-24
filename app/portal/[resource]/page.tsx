import { notFound, redirect } from "next/navigation"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { listItems, listTickets, listMessages } from "@/lib/portal/store"
import { PORTAL_RESOURCE_META, isPortalItemResource, isPortalResource } from "@/lib/portal/config"
import { ItemList } from "@/components/portal/item-list"
import { TicketsView } from "@/components/portal/tickets-view"
import { MessagesView } from "@/components/portal/messages-view"

export const dynamic = "force-dynamic"

export default async function PortalResourcePage({ params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params
  if (!isPortalResource(resource)) notFound()

  const session = await getPortalSession()
  if (!session) redirect("/portal/login")

  // Fail-closed: the client must be explicitly granted this resource.
  if (!(await clientCanAccess(session.tenantId, session.clientId, resource))) notFound()

  const meta = PORTAL_RESOURCE_META[resource]

  if (resource === "tickets") {
    const tickets = await listTickets(session.tenantId, session.clientId)
    return <TicketsView initialTickets={tickets} />
  }

  if (resource === "messages") {
    const messages = await listMessages(session.tenantId, session.clientId)
    return <MessagesView initialMessages={messages} currentUserName={session.name} />
  }

  if (isPortalItemResource(resource)) {
    const items = await listItems(session.tenantId, session.clientId, resource)
    return <ItemList resource={resource} title={meta.labelPlural} items={items} />
  }

  notFound()
}
