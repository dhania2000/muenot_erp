import type React from "react"
import { assertModuleEnabled } from "@/lib/module-access"

// SPEC 45 — enforce the tenant's `module.hr` toggle server-side. Hiding the
// sidebar link is not access control; a disabled module must not be reachable
// by direct URL, so the whole subtree 404s when the tenant disabled it.
export default async function HrModuleLayout({ children }: { children: React.ReactNode }) {
  await assertModuleEnabled("hr")
  return <>{children}</>
}
