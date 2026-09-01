import { Settings } from "lucide-react"
import { EnvironmentVariables } from "@/components/admin/environment-variables"

export default function AdminSettingsPage() {
  return <div className="flex flex-col gap-8 p-6 md:p-8"><div><div className="flex items-center gap-3"><Settings className="size-6 text-primary" /><h1 className="text-2xl font-semibold tracking-tight">Settings</h1></div><p className="mt-1 text-sm text-muted-foreground">Configure workspace behavior, secure variables, and department email accounts.</p><p className="mt-2 max-w-3xl text-xs text-muted-foreground">Department SMTP profiles use SALES_SMTP_HOST, SALES_SMTP_PORT, SALES_SMTP_SECURE, SALES_SMTP_USER, SALES_SMTP_PASS, SALES_SMTP_FROM; use the same HR_ and FINANCE_ prefixes for those departments. The shared SMTP_* variables remain the fallback.</p></div><EnvironmentVariables /></div>
}
