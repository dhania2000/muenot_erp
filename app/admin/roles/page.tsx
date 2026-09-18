import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { RolesManager } from "@/components/admin/roles-manager"
import { AbacManager } from "@/components/admin/abac-manager"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

export default async function AdminRolesPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; permissions</h1>
        <p className="text-muted-foreground">
          Define custom roles with granular module and action permissions, then layer attribute-based rules on top for
          enterprise access control.
        </p>
      </header>

      <Tabs defaultValue="roles">
        <TabsList>
          <TabsTrigger value="roles">Roles (RBAC)</TabsTrigger>
          <TabsTrigger value="abac">Attribute policies (ABAC)</TabsTrigger>
        </TabsList>
        <TabsContent value="roles" className="pt-4">
          <RolesManager />
        </TabsContent>
        <TabsContent value="abac" className="pt-4">
          <AbacManager />
        </TabsContent>
      </Tabs>
    </div>
  )
}
