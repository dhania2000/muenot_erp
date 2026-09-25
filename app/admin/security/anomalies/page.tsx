import { Suspense } from "react"
import type { Metadata } from "next"
import { SecurityHeading } from "@/components/security/security-ui"
import { RiskQueueClient } from "@/components/ai/anomaly-detection/risk-queue-client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Risk queue — AI anomaly detection",
  description:
    "Unusual payments, invoices, access changes and usage spikes with evidence, severity, owner and human-reviewed resolution.",
}

export default function AnomaliesPage() {
  return (
    <div className="flex flex-col gap-6">
      <SecurityHeading title="Risk queue" spec="SPEC 20 · #75">
        Explainable anomaly detection across payments, invoices, access changes and usage. Every alert needs a human
        review decision — nothing is blocked, reversed or revoked automatically.
      </SecurityHeading>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading risk queue…</p>}>
        <RiskQueueClient />
      </Suspense>
    </div>
  )
}
