import { OperationsEmailTemplatesClient } from "@/components/operations/operations-email-templates-client"

export default function OperationsEmailTemplatesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <p className="text-sm text-muted-foreground">Operations / Communication</p>
        <h1 className="text-2xl font-semibold tracking-tight">Operations Email Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create, version and govern reusable operations emails. Active templates power the composer
          and event automation.
        </p>
      </header>
      <OperationsEmailTemplatesClient />
    </div>
  )
}
