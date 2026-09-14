import { TdsWorkspace } from "@/components/finance/tds/workspace"

export default function Page() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">TDS Compliance</h1>
        <p className="text-sm text-muted-foreground">
          End-to-end tax deducted at source: monthly filing, liability, deposit challans, quarterly returns,
          certificates and reconciliation — across vendors, employees and receivables.
        </p>
      </header>
      <TdsWorkspace />
    </main>
  )
}
