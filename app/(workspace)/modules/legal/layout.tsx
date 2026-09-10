import type React from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"

export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")

  const has = await getFeatureChecker(session.userId, session.role)

  if (!has("legal.view_contracts") && !has("legal.view_esign")) {
    redirect("/dashboard")
  }

  return <div className="p-6 md:p-8">{children}</div>
}
