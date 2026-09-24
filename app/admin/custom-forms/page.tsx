import { LayoutTemplate } from "lucide-react"
import { CustomFormsClient } from "./custom-forms-client"

export const dynamic = "force-dynamic"

export default function CustomFormsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <LayoutTemplate className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 95</div>
          <h1 className="text-2xl font-semibold tracking-tight">Custom Forms</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Build no-code data-entry forms with sections, conditional and required fields, help
            text, attachments and an approval workflow. Published forms can be filled and submitted
            by tenant users, with submissions routed for approval when required.
          </p>
        </div>
      </header>
      <CustomFormsClient />
    </div>
  )
}
