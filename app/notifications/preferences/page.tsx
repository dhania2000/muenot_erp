import { requireTenantRole } from "@/lib/platform-guard"
import { PERMISSION_GROUPS } from "@/lib/permission-model"
import { NotificationPreferences } from "@/components/notification-preferences"
export const dynamic="force-dynamic"
export default async function Page(){
  const g=await requireTenantRole("employee")
  if(!g.ok)return <p>Sign in to your tenant account to manage preferences.</p>
  const moduleCatalog=PERMISSION_GROUPS.map(group=>({key:group.slug,label:group.label}))
  return <main className="max-w-3xl mx-auto p-6"><NotificationPreferences moduleCatalog={moduleCatalog}/></main>
}
