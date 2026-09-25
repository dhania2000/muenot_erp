import { AuditRetentionClient } from "@/components/security/audit-retention-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Audit retention · Security & Access",
  description: "Configure audit log retention, archiving, legal holds, and immutable exports.",
}

export default function AuditRetentionPage() {
  return <AuditRetentionClient />
}
