"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, CheckCircle2 } from "lucide-react"

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Unable to reset password")
        setLoading(false)
        return
      }

      setDone(true)
      setLoading(false)
      setTimeout(() => router.push("/login"), 2000)
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <CheckCircle2 className="size-5" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">Password updated</h2>
        <p className="text-sm text-muted-foreground">Redirecting you to sign in…</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            {error.toLowerCase().includes("expired") || error.toLowerCase().includes("invalid") ? (
              <>
                Request a{" "}
                <Link href="/forgot-password" className="font-medium underline">
                  new reset link
                </Link>
                .
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={8}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={8}
          required
        />
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="animate-spin" />}
        Reset password
      </Button>
    </form>
  )
}
