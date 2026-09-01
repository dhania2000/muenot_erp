"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Loader2, Users2, TrendingUp, Wallet, UserPlus, Settings2 } from "lucide-react"
import type { EmployeeRow, ModuleWithFeatures } from "@/components/admin/employees-table"

const moduleIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  hr: Users2,
  sales: TrendingUp,
  finance: Wallet,
  recruitment: UserPlus,
  operations: Settings2,
}

export function PermissionsDialog({
  employee,
  modules,
  onOpenChange,
}: {
  employee: EmployeeRow | null
  modules: ModuleWithFeatures[]
  onOpenChange: (open: boolean) => void
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!employee) return
    setLoading(true)
    fetch(`/api/admin/employees/${employee.id}/permissions`)
      .then((res) => res.json())
      .then((data: { featureSlugs: string[] }) => {
        const slugSet = new Set(data.featureSlugs)
        const ids = new Set<number>()
        modules.forEach((m) => m.features.forEach((f) => slugSet.has(f.slug) && ids.add(f.id)))
        setSelected(ids)
      })
      .finally(() => setLoading(false))
  }, [employee, modules])

  function toggleFeature(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleModule(mod: ModuleWithFeatures, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      mod.features.forEach((f) => (checked ? next.add(f.id) : next.delete(f.id)))
      return next
    })
  }

  async function handleSave() {
    if (!employee) return
    setSaving(true)
    try {
      await fetch(`/api/admin/employees/${employee.id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: Array.from(selected) }),
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!employee} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Permissions {employee ? `— ${employee.name}` : ""}</DialogTitle>
          <DialogDescription>
            Choose exactly which features this employee can access in each module.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-56 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <Tabs defaultValue={modules[0]?.slug} className="w-full">
            <TabsList className="flex w-full max-w-full flex-nowrap justify-start gap-1 overflow-x-scroll overflow-y-hidden rounded-md p-1 pb-2 [scrollbar-color:hsl(var(--muted-foreground))_hsl(var(--muted))] [scrollbar-width:auto]">
              {modules.map((m) => {
                const Icon = moduleIcons[m.slug] ?? Settings2
                const grantedCount = m.features.filter((f) => selected.has(f.id)).length
                return (
                  <TabsTrigger key={m.slug} value={m.slug} className="shrink-0 gap-1.5 whitespace-nowrap">
                    <Icon className="size-3.5" />
                    {m.name}
                    {grantedCount > 0 && (
                      <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                        {grantedCount}
                      </span>
                    )}
                  </TabsTrigger>
                )
              })}
            </TabsList>

            {modules.map((m) => {
              const allChecked = m.features.length > 0 && m.features.every((f) => selected.has(f.id))
              return (
                <TabsContent key={m.slug} value={m.slug} className="flex flex-col gap-3">
                  <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {m.features.length} feature{m.features.length === 1 ? "" : "s"} in {m.name}
                    </span>
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <Checkbox
                        checked={allChecked}
                        onCheckedChange={(checked) => toggleModule(m, Boolean(checked))}
                      />
                      Select all
                    </label>
                  </div>

                  <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                    {m.features.map((f) => (
                      <label
                        key={f.id}
                        className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted"
                      >
                        <Checkbox
                          checked={selected.has(f.id)}
                          onCheckedChange={() => toggleFeature(f.id)}
                          className="mt-0.5"
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-medium">{f.name}</span>
                          {f.description && (
                            <span className="text-xs text-muted-foreground">{f.description}</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </TabsContent>
              )
            })}
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="animate-spin" />}
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
