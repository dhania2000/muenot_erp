import { FinanceEmailTemplatesClient } from "@/components/finance/finance-email-templates-client"

export default function FinanceEmailTemplatesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <p className="text-sm text-muted-foreground">Finance / Communication</p>
        <h1 className="text-2xl font-semibold tracking-tight">Finance Email Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create, version and govern reusable finance emails. Active templates power the composer
          and invoice communication.
        </p>
      </header>
      <FinanceEmailTemplatesClient />
    </div>
  )
}
