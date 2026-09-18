import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { MakerCheckerManager } from "@/components/admin/maker-checker-manager"

export const metadata = {
  title: "Maker-checker controls",
  description: "Require a second person to approve high-risk operations before they take effect.",
}

export default async function MakerCheckerPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Maker-checker controls</h1>
        <p className="text-sm text-muted-foreground">
          Choose which high-risk operations must be prepared by one person and released by another. Gated changes
          are captured and held — never applied — until a different user approves them through the approval
          authority chain.
        </p>
      </header>
      <MakerCheckerManager />
    </main>
  )
}
