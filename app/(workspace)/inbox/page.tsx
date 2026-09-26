import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { UnifiedInbox } from "@/components/collaboration/unified-inbox"

export const metadata = { title: "Inbox — Tasks & approvals" }

export default async function InboxPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-6">
      <header>
        <h1 className="text-xl font-semibold text-balance">Inbox</h1>
        <p className="text-sm text-muted-foreground">Your open tasks and pending approvals across every module you can access.</p>
      </header>
      <UnifiedInbox />
    </main>
  )
}
