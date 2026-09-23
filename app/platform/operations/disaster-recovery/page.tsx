import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { DisasterRecoveryConsole } from "@/components/platform/disaster-recovery-console"

export const dynamic = "force-dynamic"

// SPEC 76 — Disaster Recovery. Readiness is DERIVED from the live SPEC 75 backup
// engine (recovery-point recency, restore verification) and real drill history —
// never asserted. Platform staff can view; super admins can edit objectives,
// run drills and drive the incident workflow.
export default async function DisasterRecoveryPage() {
  const staff = await requirePlatformStaff()
  if (!staff.ok) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        {staff.reason}. Platform staff privileges are required to view disaster recovery.
      </div>
    )
  }
  const manage = await requirePlatformSuperAdmin()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Disaster recovery</h1>
        <p className="text-sm text-muted-foreground">
          Recovery objectives (RPO/RTO), procedures and readiness per critical service. Readiness is reported
          honestly — a service cannot show &quot;ready&quot; without a recent recovery point, a verified restore
          and a passing drill.
        </p>
      </header>
      <DisasterRecoveryConsole canManage={manage.ok} />
    </div>
  )
}
