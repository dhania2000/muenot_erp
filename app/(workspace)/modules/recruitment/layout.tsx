import type React from "react"
import { assertModuleEnabled } from "@/lib/module-access"

// SPEC 45 — enforce the tenant's `module.recruitment` toggle server-side.
export default async function RecruitmentModuleLayout({ children }: { children: React.ReactNode }) {
  await assertModuleEnabled("recruitment")
  return <>{children}</>
}
