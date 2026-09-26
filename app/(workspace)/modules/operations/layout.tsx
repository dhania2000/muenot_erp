import type React from "react"
import { assertModuleEnabled } from "@/lib/module-access"

// SPEC 45 — enforce the tenant's `module.operations` toggle server-side.
export default async function OperationsModuleLayout({ children }: { children: React.ReactNode }) {
  await assertModuleEnabled("operations")
  return <>{children}</>
}
