import type { Metadata } from "next"
import { SupportDesk } from "@/components/support-sla/support-desk"

export const metadata: Metadata = { title: "Support · Muenot" }

/** Spec28 (#127) — Customer support desk; exempt from maintenance gating. */
export default function SupportPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold">Muenot support</h1>
        <p className="mt-1 text-sm text-muted-foreground">Report a problem with the platform and track our response against your plan&apos;s SLA.</p>
      </header>
      <SupportDesk />
    </main>
  )
}
