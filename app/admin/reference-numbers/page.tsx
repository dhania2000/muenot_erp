import { Barcode } from "lucide-react"
import { ReferenceClient } from "./reference-client"

export const dynamic = "force-dynamic"

export default function ReferenceNumbersPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Barcode className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 93</div>
          <h1 className="text-2xl font-semibold tracking-tight">Reference Number Management</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Let every business document carry the numbers it is known by — internal number, external,
            customer, vendor, PO and contract references — and detect duplicates per document where
            configured. Blocked references can never be shared by two documents.
          </p>
        </div>
      </header>
      <ReferenceClient />
    </div>
  )
}
