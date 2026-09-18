import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { ApprovalAuthorityManager } from "@/components/admin/approval-authority-manager"

export const metadata = {
  title: "Approval authority",
  description: "Configure approval rules, delegation and escalation.",
}

export default async function ApprovalAuthorityPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approval authority</h1>
        <p className="text-sm text-muted-foreground">
          Define who must approve what across the business — by amount, department, role or entity — with
          multi-level, sequential and parallel chains, delegation and escalation.
        </p>
      </header>
      <ApprovalAuthorityManager />
    </main>
  )
}
