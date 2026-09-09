import Image from "next/image"
import { LoginForm } from "@/components/login-form"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2 } from "lucide-react"

const modules = [
  { name: "HR", icon: Users2 },
  { name: "Sales", icon: TrendingUp },
  { name: "Finance", icon: Wallet },
  { name: "Recruitment", icon: UserPlus },
  { name: "Operations", icon: Settings2 },
]

export default function LoginPage() {
  return (
    <main className="flex min-h-svh flex-col lg:flex-row">
      <section className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center">
          <Image src="/muenot-logo-transparent.png" alt="Muenot" width={132} height={30} className="h-6 w-auto object-contain" priority />
        </div>

        <div className="flex flex-col gap-8">
          <h1 className="max-w-md text-balance text-4xl font-semibold leading-tight tracking-tight">
            One workspace to run every part of the business.
          </h1>
          <p className="max-w-md text-pretty text-sm leading-relaxed text-sidebar-foreground/70">
            Muenot brings HR, Sales, Finance, Recruitment, and Operations together, with permissions your admin
            controls down to the feature level.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {modules.map((m) => (
              <div
                key={m.name}
                className="flex items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-3 py-2.5"
              >
                <m.icon className="size-4 text-sidebar-primary" />
                <span className="text-sm font-medium">{m.name}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-sidebar-foreground/50">
          Access is granted per employee, per feature — configured by your administrator.
        </p>
      </section>

      <section className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col gap-1 lg:hidden">
            <div className="mb-4">
              <Image src="/muenot-logo-transparent.png" alt="Muenot" width={132} height={30} className="h-6 w-auto object-contain" priority />
            </div>
          </div>

          <div className="mb-8 flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">Enter your credentials to access your workspace.</p>
          </div>

          <LoginForm />

          <p className="mt-8 text-center text-xs text-muted-foreground">
            Don&apos;t have access? Ask your administrator to create an account for you.
          </p>
        </div>
      </section>
    </main>
  )
}
