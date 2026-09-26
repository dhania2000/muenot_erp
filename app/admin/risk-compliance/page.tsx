import { RiskComplianceClient } from "./risk-compliance-client"

export const metadata = {
  title: "Risk & compliance dashboard",
  description: "Aggregated risk, security, finance/tax and HR compliance signals across the organization.",
}

export default function RiskCompliancePage() {
  return <RiskComplianceClient />
}
