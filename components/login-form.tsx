"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Eye, EyeOff } from "lucide-react"

export type SocialProviders = {
  google?: boolean
  linkedin?: boolean
  facebook?: boolean
}

export type SsoLoginProvider = {
  id: number
  name: string
  type: "oidc" | "saml"
}

const PROVIDER_LABELS: Record<keyof SocialProviders, string> = {
  google: "Google",
  linkedin: "LinkedIn",
  facebook: "Facebook",
}

export function LoginForm({
  social,
  signupEnabled = false,
  ssoProviders = [],
  ssoError,
}: {
  social?: SocialProviders
  signupEnabled?: boolean
  ssoProviders?: SsoLoginProvider[]
  ssoError?: string | null
}) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(ssoError ?? null)
  const [loading, setLoading] = useState(false)

  const enabledProviders = (Object.keys(PROVIDER_LABELS) as (keyof SocialProviders)[]).filter(
    (p) => social?.[p],
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Unable to sign in")
        setLoading(false)
        return
      }

      if (data.user.mustChangePassword) {
        router.push("/change-password")
        return
      }

      router.push(data.user.role === "admin" ? "/admin" : "/dashboard")
      router.refresh()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
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

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-md"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="animate-spin" />}
        Sign in
      </Button>

      {(enabledProviders.length > 0 || ssoProviders.length > 0) && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or continue with
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="flex flex-col gap-2">
            {ssoProviders.map((p) => (
              <Button key={p.id} type="button" variant="outline" size="lg" className="w-full" asChild>
                <a href={`/api/auth/sso/${p.id}/login`}>Continue with {p.name}</a>
              </Button>
            ))}
            {enabledProviders.map((p) => (
              <Button
                key={p}
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                onClick={() =>
                  setError(
                    `${PROVIDER_LABELS[p]} sign-in is enabled but not fully configured yet. Please sign in with your work email or contact your administrator.`,
                  )
                }
              >
                Continue with {PROVIDER_LABELS[p]}
              </Button>
            ))}
          </div>
        </div>
      )}

      {signupEnabled && (
        <p className="text-center text-xs text-muted-foreground">
          New here?{" "}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </p>
      )}
    </form>
  )
}
