import { HrEmailTemplatesClient } from "@/components/hr/hr-email-templates-client"

export default function HrEmailTemplatesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <p className="text-sm text-muted-foreground">HR / Communication</p>
        <h1 className="text-2xl font-semibold tracking-tight">HR Email Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create, version and govern reusable HR emails. Active templates power the composer and
          event automation.
        </p>
      </header>
      <HrEmailTemplatesClient />
    </div>
  )
}
