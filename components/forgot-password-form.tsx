"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, ArrowLeft, MailCheck } from "lucide-react"

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Unable to send reset link")
        setLoading(false)
        return
      }

      setSent(true)
      setLoading(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <MailCheck className="size-5" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-xl font-semibold tracking-tight">Check your email</h2>
          <p className="text-sm text-pretty text-muted-foreground">
            If an account exists for <span className="font-medium text-foreground">{email}</span>, we&apos;ve sent a
            link to reset your password. The link expires in 1 hour.
          </p>
        </div>
        <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
          <ArrowLeft className="size-4" />
          Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="animate-spin" />}
        Send reset link
      </Button>

      <Link href="/login" className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Back to sign in
      </Link>
    </form>
  )
}
