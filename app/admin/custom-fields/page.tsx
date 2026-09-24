import { SlidersHorizontal } from "lucide-react"
import { CustomFieldsClient } from "./custom-fields-client"

export const dynamic = "force-dynamic"

export default function CustomFieldsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <SlidersHorizontal className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 94</div>
          <h1 className="text-2xl font-semibold tracking-tight">Custom Fields</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Extend any module&apos;s records with tenant-defined fields — text, number, date,
            boolean, dropdown, multi-select, user, department, entity, file, URL, currency and safe
            formulas — with per-role view and edit permissions. No code required.
          </p>
        </div>
      </header>
      <CustomFieldsClient />
    </div>
  )
}
