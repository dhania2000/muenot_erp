import { AuditLogViewer } from "@/components/security/audit-log-viewer"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Audit log · Security & Access",
  description: "Immutable, append-only record of every meaningful operation across the platform.",
}

export default function AuditLogPage() {
  return <AuditLogViewer />
}
