"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MessageCircle, CheckCircle2, Loader2, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { EmbeddedSignupConnect } from "@/components/marketing/whatsapp/embedded-signup-connect"

/**
 * Post-signup WhatsApp onboarding step. The tenant already exists and the admin
 * is signed in, so connecting WhatsApp here attaches to the correct tenant. The
 * step is optional — the admin can skip and connect later from settings — but
 * either way we advance the tenant's onboarding_state to 'active' so this page
 * is a one-time gate, not a recurring interruption.
 */
export function WhatsAppOnboarding({ adminName }: { adminName: string }) {
  const router = useRouter()
  const [finishing, setFinishing] = React.useState(false)

  async function finishOnboarding(reason: "connected" | "skipped") {
    setFinishing(true)
    try {
      await fetch("/api/onboarding/whatsapp/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
    } catch {
      // Non-fatal: the admin can still proceed and complete setup later.
    }
    router.push("/")
    router.refresh()
  }

  const benefits = [
    "Send and receive customer messages inside the workspace",
    "Trigger WhatsApp templates from Sales and Recruitment",
    "Keep every conversation attached to the right lead or candidate",
  ]

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex flex-col gap-2 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
            <MessageCircle className="size-6 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Connect WhatsApp Business</h1>
          <p className="text-pretty text-sm text-muted-foreground">
            Welcome, {adminName}. Your workspace is ready. Connect your WhatsApp Business account now to message
            customers directly from your ERP — or skip and do it later.
          </p>
        </div>

        <Card className="flex flex-col gap-6 p-6">
          <ul className="flex flex-col gap-3">
            {benefits.map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                <span className="text-muted-foreground">{b}</span>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-3">
            <EmbeddedSignupConnect
              className="w-full"
              onConnected={() => {
                toast.success("WhatsApp connected. Finishing setup…")
                void finishOnboarding("connected")
              }}
            />
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => finishOnboarding("skipped")}
              disabled={finishing}
            >
              {finishing ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              Skip for now
            </Button>
          </div>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          You can always connect or change your WhatsApp number later from Settings.
        </p>
      </div>
    </main>
  )
}
