import type React from "react"
import { assertModuleEnabled } from "@/lib/module-access"

// SPEC 45 — enforce the tenant's `module.tickets` toggle server-side.
export default async function TicketsModuleLayout({ children }: { children: React.ReactNode }) {
  await assertModuleEnabled("tickets")
  return <>{children}</>
}
