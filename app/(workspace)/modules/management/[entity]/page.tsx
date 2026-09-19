import { notFound } from "next/navigation"
import { ManagementEntityClient } from "@/components/management/management-entity-client"
import { getEntityDef } from "@/lib/management-entities"

export default async function ManagementEntityPage({
  params,
}: {
  params: Promise<{ entity: string }>
}) {
  const { entity } = await params
  const def = getEntityDef(entity)
  if (!def) notFound()
  return <ManagementEntityClient entity={def} />
}
