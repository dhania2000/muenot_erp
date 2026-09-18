import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"

/**
 * Subscription & Billing is an admin-only module (mirrors the Administration
 * gating). Every /modules/billing/* page calls this to enforce the session +
 * role check before rendering.
 */
export async function billingGuard() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")
  return session
}
