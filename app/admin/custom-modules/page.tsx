import { Blocks } from "lucide-react"
import { CustomModulesClient } from "./custom-modules-client"

export const dynamic = "force-dynamic"

export default function CustomModulesPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Blocks className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 96</div>
          <h1 className="text-2xl font-semibold tracking-tight">Custom Module Framework</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Build entirely new lightweight modules for your workspace — a custom entity with its own
            fields, list view, per-role permissions, workflow states, reports and attachments. Records
            are validated and isolated per tenant. No code required.
          </p>
        </div>
      </header>
      <CustomModulesClient />
    </div>
  )
}
