import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { LoginForm } from "./login-form"

export default async function LoginPage() {
  const session = await getSession()
  if (session) redirect("/")

  return (
    <main className="grid min-h-svh lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-md bg-sidebar-primary font-mono text-sm font-bold text-sidebar-primary-foreground">
            M
          </div>
          <span className="text-lg font-semibold tracking-tight">Muenot ERP</span>
        </div>

        <div className="max-w-md">
          <h1 className="text-balance text-3xl font-semibold leading-tight">
            One suite for HR, Sales, Finance, Recruitment & Operations.
          </h1>
          <p className="mt-4 text-pretty text-sm leading-relaxed text-sidebar-foreground/70">
            Role-based access keeps every team focused on exactly the modules and features they need — controlled
            entirely by your administrator.
          </p>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs text-sidebar-foreground/60">
          <span>HR</span>
          <span>SALES</span>
          <span>FINANCE</span>
          <span>RECRUITMENT</span>
          <span>OPERATIONS</span>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
              M
            </div>
            <span className="text-lg font-semibold tracking-tight">Muenot ERP</span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1.5 mb-8 text-sm text-muted-foreground">
            Enter your credentials to access your workspace.
          </p>

          <LoginForm />

          <p className="mt-8 rounded-md border border-border bg-muted/50 px-3 py-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
            Demo admin — admin@muenot.co.in / admin123
            <br />
            (available after running the DB setup script)
          </p>
        </div>
      </div>
    </main>
  )
}
