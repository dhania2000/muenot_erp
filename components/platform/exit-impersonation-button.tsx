"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { LogOut } from "lucide-react"

/** Ends the current impersonation and returns to the operator's home tenant. */
export function ExitImpersonationButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function exit() {
    setBusy(true)
    try {
      const res = await fetch("/api/platform/impersonation", { method: "DELETE" })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}) as Record<string, unknown>)
        toast.error((json as { error?: string }).error || "Could not exit impersonation")
        return
      }
      toast.success("Exited impersonation")
      router.push("/platform")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      onClick={exit}
      disabled={busy}
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 border-amber-600/50 bg-transparent text-amber-900 hover:bg-amber-500/20 dark:text-amber-100"
    >
      <LogOut className="size-3.5" />
      Exit tenant
    </Button>
  )
}
