import { SecurityTabs } from "@/components/security/security-tabs"
import { AuditLogViewer } from "@/components/security/audit-log-viewer"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Audit log · Security & Access",
  description: "Immutable, append-only record of every meaningful operation across the platform.",
}

export default function AuditLogPage() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Security &amp; Access</h1>
        <p className="text-muted-foreground">
          Search, inspect, and export the enterprise audit trail.
        </p>
      </header>
      <SecurityTabs />
      <AuditLogViewer />
    </main>
  )
}
