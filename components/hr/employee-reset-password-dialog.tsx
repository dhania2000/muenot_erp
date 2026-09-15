"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Copy, Check } from "lucide-react"

/**
 * System-admin-only password reset launched from an employee profile.
 * Resets by employee id via /api/hr/employees/[id]/reset-password.
 */
export function EmployeeResetPasswordDialog({
  open,
  employeeId,
  employeeName,
  employeeEmail,
  onOpenChange,
}: {
  open: boolean
  employeeId: number
  employeeName: string
  employeeEmail?: string | null
  onOpenChange: (open: boolean) => void
}) {
  const [mode, setMode] = useState<"generate" | "custom">("generate")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ tempPassword: string | null } | null>(null)
  const [copied, setCopied] = useState(false)

  function reset() {
    setMode("generate")
    setPassword("")
    setError(null)
    setLoading(false)
    setResult(null)
    setCopied(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`/api/hr/employees/${employeeId}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "custom" ? { password } : {}),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Unable to reset password")
        setLoading(false)
        return
      }

      setResult({ tempPassword: data.tempPassword ?? (mode === "custom" ? password : null) })
      setLoading(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  function copyPassword() {
    if (!result?.tempPassword) return
    navigator.clipboard.writeText(result.tempPassword)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Password reset</DialogTitle>
              <DialogDescription>
                {employeeName}&apos;s password has been reset. They&apos;ll be asked to set a new one on their next
                sign-in.
              </DialogDescription>
            </DialogHeader>

            {result.tempPassword && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-sm">
                <span>{result.tempPassword}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={copyPassword}
                  aria-label="Copy password"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
            )}

            <DialogFooter>
              <Button
                onClick={() => {
                  onOpenChange(false)
                  reset()
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Reset the login password for {employeeName}
                {employeeEmail ? ` (${employeeEmail})` : ""}.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 py-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={mode === "generate" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode("generate")}
                  >
                    Generate temporary
                  </Button>
                  <Button
                    type="button"
                    variant={mode === "custom" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode("custom")}
                  >
                    Set manually
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {mode === "generate"
                    ? "A secure temporary password will be generated and shown to you to share."
                    : "Enter a password to set for this employee (minimum 8 characters)."}
                </p>
              </div>

              {mode === "custom" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="emp-new-password">New password</Label>
                  <Input
                    id="emp-new-password"
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    required
                    autoComplete="off"
                  />
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                Reset password
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
