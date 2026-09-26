import type React from "react"
import { assertModuleEnabled } from "@/lib/module-access"

// SPEC 45 — enforce the tenant's `module.finance` toggle server-side so a
// disabled module is neither shown nor reachable by direct URL.
export default async function FinanceModuleLayout({ children }: { children: React.ReactNode }) {
  await assertModuleEnabled("finance")
  return <>{children}</>
}
