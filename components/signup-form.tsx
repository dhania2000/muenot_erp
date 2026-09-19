"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2 } from "lucide-react"

type FieldErrors = Partial<Record<"companyName" | "adminName" | "email" | "mobile" | "password", string>>

export function SignupForm() {
  const router = useRouter()
  const [companyName, setCompanyName] = useState("")
  const [adminName, setAdminName] = useState("")
  const [email, setEmail] = useState("")
  const [mobile, setMobile] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setFieldErrors({})

    if (password !== confirm) {
      setFieldErrors({ password: "Passwords do not match." })
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, adminName, email, mobile, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        if (data.field) setFieldErrors({ [data.field as keyof FieldErrors]: data.error })
        else setError(data.error || "Unable to create your account")
        setLoading(false)
        return
      }

      router.push(data.redirect || "/onboarding/whatsapp")
      router.refresh()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="companyName">Company name</Label>
        <Input
          id="companyName"
          autoComplete="organization"
          placeholder="Acme Pvt Ltd"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          aria-invalid={Boolean(fieldErrors.companyName)}
          required
        />
        {fieldErrors.companyName && <p className="text-xs text-destructive">{fieldErrors.companyName}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="adminName">Your name</Label>
        <Input
          id="adminName"
          autoComplete="name"
          placeholder="Priya Sharma"
          value={adminName}
          onChange={(e) => setAdminName(e.target.value)}
          aria-invalid={Boolean(fieldErrors.adminName)}
          required
        />
        {fieldErrors.adminName && <p className="text-xs text-destructive">{fieldErrors.adminName}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(fieldErrors.email)}
          required
        />
        {fieldErrors.email && <p className="text-xs text-destructive">{fieldErrors.email}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="mobile">Mobile number</Label>
        <Input
          id="mobile"
          type="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(fieldErrors.password)}
          required
        />
        {fieldErrors.password ? (
          <p className="text-xs text-destructive">{fieldErrors.password}</p>
        ) : (
          <p className="text-xs text-muted-foreground">At least 8 characters, including a letter and a number.</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="animate-spin" />}
        Create business account
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
