import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { TaskManagementClient } from "@/components/tasks/task-management-client"

export const dynamic = "force-dynamic"

export default async function TasksPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  return (
    <TaskManagementClient
      currentUserId={session.userId}
      currentUserName={session.name ?? session.email ?? "You"}
    />
  )
}
