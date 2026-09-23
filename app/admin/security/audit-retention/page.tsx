import { SecurityTabs } from "@/components/security/security-tabs"
import { AuditRetentionClient } from "@/components/security/audit-retention-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Audit retention · Security & Access",
  description: "Configure audit log retention, archiving, legal holds, and immutable exports.",
}

export default function AuditRetentionPage() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Security &amp; Access</h1>
        <p className="text-muted-foreground">
          Configure how long the immutable audit trail is retained, archive and purge aged entries, and place legal
          holds.
        </p>
      </header>
      <SecurityTabs />
      <AuditRetentionClient />
    </main>
  )
}
