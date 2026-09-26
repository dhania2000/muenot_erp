import type React from "react"
import { assertModuleEnabled } from "@/lib/module-access"

// SPEC 45 — enforce the tenant's `module.products` toggle server-side.
export default async function ProductsModuleLayout({ children }: { children: React.ReactNode }) {
  await assertModuleEnabled("products")
  return <>{children}</>
}
