import { Settings } from "lucide-react"
import { EnvironmentVariables } from "@/components/admin/environment-variables"
import { CompanySettings } from "@/components/admin/company-settings"
import { MessagePermissions } from "@/components/admin/message-permissions"

export default function AdminSettingsPage() {
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <div>
        <div className="flex items-center gap-3">
          <Settings className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Company Settings</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Configure every part of your workspace — company profile, finance, HR, security, integrations and more. Each
          section is a form you can fill in and save.
        </p>
      </div>
      <CompanySettings />
      <MessagePermissions />
      <EnvironmentVariables />
    </div>
  )
}
