import type { Metadata } from "next"
import { ScanClient } from "./scan-client"

export const metadata: Metadata = {
  title: "Event Access",
  description: "Verify event access",
  robots: { index: false, follow: false },
}

export default async function EventScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <ScanClient token={token} />
    </main>
  )
}
