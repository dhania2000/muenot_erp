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
import type { EmployeeRow } from "@/components/admin/employees-table"

export function InviteEmployeeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (employee: EmployeeRow) => void
}) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [designation, setDesignation] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function reset() {
    setName("")
    setEmail("")
    setDesignation("")
    setError(null)
    setTempPassword(null)
    setCopied(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/admin/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, designation }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Unable to create employee")
        setLoading(false)
        return
      }

      setTempPassword(data.tempPassword)
      onCreated({
        id: data.employee.id,
        name: data.employee.name,
        email: data.employee.email,
        designation: data.employee.designation || null,
        role: "employee",
        status: "active",
        must_change_password: 1,
        created_at: new Date().toISOString(),
      })
      setLoading(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  function copyPassword() {
    if (!tempPassword) return
    navigator.clipboard.writeText(tempPassword)
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
        {tempPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Employee created</DialogTitle>
              <DialogDescription>
                Share this temporary password with {name}. They&apos;ll be asked to set a new one on first
                sign-in.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-sm">
              <span>{tempPassword}</span>
              <Button type="button" variant="ghost" size="icon-sm" onClick={copyPassword} aria-label="Copy password">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>

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
              <DialogTitle>Invite employee</DialogTitle>
              <DialogDescription>
                Create an account for a new team member. You can assign module permissions afterward.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 py-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="designation">Designation (optional)</Label>
                <Input
                  id="designation"
                  placeholder="e.g. Sales Executive"
                  value={designation}
                  onChange={(e) => setDesignation(e.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                Create account
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
