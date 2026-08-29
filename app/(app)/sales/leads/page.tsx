import { redirect } from "next/navigation"
import { getAuthContext } from "@/lib/access"
import { listLeads, distinctLeadStatuses, safe } from "@/lib/sales"
import { PageHeader } from "@/components/page-header"
import { DbNotConnected } from "@/components/states"
import { TableSearch } from "@/components/sales/table-search"
import { StatusFilter } from "@/components/sales/status-filter"
import { LeadsClient } from "@/components/sales/leads-client"

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>
}) {
  const ctx = await getAuthContext()
  if (!ctx) redirect("/login")
  if (!ctx.access.canView("sales", "leads")) redirect("/")

  const sp = await searchParams
  const [leadsRes, statusesRes] = await Promise.all([
    safe(() => listLeads({ search: sp.q, status: sp.status })),
    safe(() => distinctLeadStatuses()),
  ])

  return (
    <>
      <PageHeader title="Leads" description="Your sales pipeline across every stage.">
        <TableSearch placeholder="Search leads…" />
        {statusesRes.ok ? <StatusFilter statuses={statusesRes.data} /> : null}
      </PageHeader>

      <div className="p-6">
        {!leadsRes.ok ? (
          <DbNotConnected error={leadsRes.error} />
        ) : (
          <LeadsClient leads={leadsRes.data} canEdit={ctx.access.canEdit("sales", "leads")} />
        )}
      </div>
    </>
  )
}
