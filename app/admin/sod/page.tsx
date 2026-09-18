import { SodManager } from "@/components/admin/sod-manager"

export const metadata = {
  title: "Segregation of duties",
}

export default function SodPage() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Segregation of duties</h1>
        <p className="text-sm text-muted-foreground">
          Configure incompatible duty combinations, review who currently breaches them, and audit every change.
        </p>
      </header>
      <SodManager />
    </div>
  )
}
