import { Settings } from "lucide-react"
import { EnvironmentVariables } from "@/components/admin/environment-variables"

export default function AdminSettingsPage() {
  return <div className="flex flex-col gap-8 p-6 md:p-8"><div><div className="flex items-center gap-3"><Settings className="size-6 text-primary" /><h1 className="text-2xl font-semibold tracking-tight">Settings</h1></div><p className="mt-1 text-sm text-muted-foreground">Configure workspace behavior and secure environment variables.</p></div><EnvironmentVariables /></div>
}
