import { Suspense } from "react"
import { GenerateLetterCreateClient } from "@/components/hr/generate-letter-create-client"

export default function GenerateLetterCreatePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground md:p-8">Loading…</div>}>
      <GenerateLetterCreateClient />
    </Suspense>
  )
}
