import { Hash } from "lucide-react"
import { NumberingClient } from "./numbering-client"

export const dynamic = "force-dynamic"

export default function NumberingEnginePage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Hash className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 92</div>
          <h1 className="text-2xl font-semibold tracking-tight">Numbering Engine</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Centralized, tenant-specific auto-numbering for every entity — prefixes, suffixes, padding,
            fiscal-year and periodic resets, and custom formats. Numbers are allocated atomically so
            duplicates cannot occur.
          </p>
        </div>
      </header>
      <NumberingClient />
    </div>
  )
}
