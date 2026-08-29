import { redirect } from "next/navigation"
import { getAuthContext, visibleNav } from "@/lib/access"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "@/components/ui/sonner"

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  if (!ctx) redirect("/login")

  const nav = visibleNav(ctx.access)

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <AppSidebar nav={nav} user={ctx.user} isAdmin={ctx.access.isAdmin} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
      <Toaster position="top-right" />
    </div>
  )
}
