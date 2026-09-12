import { Suspense } from "react"
import { ShiftRotationsClient } from "@/components/hr/shift-rotations-client"

export default function ShiftRotationsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading rotations…</div>}>
      <ShiftRotationsClient />
    </Suspense>
  )
}
