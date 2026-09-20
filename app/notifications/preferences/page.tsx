import { requireTenantRole } from "@/lib/platform-guard"
import { NotificationPreferences } from "@/components/notification-preferences"
export const dynamic="force-dynamic"
export default async function Page(){const g=await requireTenantRole("employee");if(!g.ok)return <p>Sign in to your tenant account to manage preferences.</p>;return <main className="max-w-3xl mx-auto p-6"><NotificationPreferences/></main>}
